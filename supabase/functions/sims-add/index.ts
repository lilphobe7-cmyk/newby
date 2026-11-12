import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';
import { validateIccid, iccidPrefix } from '../_shared/iccid.ts';
import { normalizeMsisdn, isValidMsisdn } from '../_shared/msisdn.ts';
import { parseExpiry } from '../_shared/expiry.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'METHOD_NOT_ALLOWED');

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const userSb = userClient(authHeader);
    const { data: { user } } = await userSb.auth.getUser();
    if (!user) return errorResponse('Invalid session', 401, 'UNAUTHORIZED');

    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (!raw || raw.trim() === '') return errorResponse('Empty body', 400, 'EMPTY_BODY');
      body = JSON.parse(raw);
    } catch {
      return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
    }

    const missing = requireFields(body, ['workspace_id', 'batch_id', 'iccid']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const workspace_id = String(body.workspace_id).trim();
    const batch_id = String(body.batch_id).trim();
    const rawIccid = String(body.iccid).trim();
    const rawMsisdn = body.msisdn ? String(body.msisdn).trim() : null;
    const rawExpiry = body.expiry_date ? String(body.expiry_date).trim() : null;
    const scan_method = body.scan_method ? String(body.scan_method).trim() : 'MANUAL_ENTRY';
    const scan_confidence = body.scan_confidence ?? null;
    const raw_scan_text = body.raw_scan_text ? String(body.raw_scan_text).trim() : null;
    const notes = body.notes ? String(body.notes).trim() : null;

    // Validate ICCID
    const iccidValidation = validateIccid(rawIccid);
    if (!iccidValidation.normalized) {
      return errorResponse('ICCID is empty after normalization', 400, 'EMPTY_ICCID');
    }
    if (!iccidValidation.valid_length) {
      return errorResponse(
        `ICCID must be 19 or 20 digits (got ${iccidValidation.normalized.length})`,
        400,
        'INVALID_ICCID_LENGTH'
      );
    }

    // Validate and normalize MSISDN (optional)
    let msisdn: string | null = null;
    if (rawMsisdn) {
      msisdn = normalizeMsisdn(rawMsisdn);
      if (!msisdn) {
        return errorResponse(`Could not normalize phone number: ${rawMsisdn}`, 400, 'INVALID_MSISDN');
      }
    }

    // Parse expiry (optional)
    let expiry_date: string | null = null;
    if (rawExpiry) {
      expiry_date = parseExpiry(rawExpiry);
      if (!expiry_date) {
        return errorResponse(`Could not parse expiry date: ${rawExpiry}`, 400, 'INVALID_EXPIRY');
      }
    }

    const admin = adminClient();

    // Verify caller is MAIN_AGENT
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can add SIMs', 403, 'FORBIDDEN');
    }

    // Verify batch exists, is OPEN, and belongs to workspace
    const { data: batch } = await admin
      .from('batches')
      .select('id, workspace_id, network_id, status, reference')
      .eq('id', batch_id)
      .maybeSingle();

    if (!batch) return errorResponse('Batch not found', 404, 'BATCH_NOT_FOUND');
    if (batch.workspace_id !== workspace_id) {
      return errorResponse('Batch does not belong to this workspace', 403, 'BATCH_MISMATCH');
    }
    if (batch.status !== 'OPEN') {
      return errorResponse(
        `Cannot add SIMs to a batch with status ${batch.status}. Only OPEN batches accept SIMs.`,
        409,
        'BATCH_NOT_OPEN'
      );
    }

    // Duplicate check
    const { data: existing } = await admin
      .from('sims')
      .select('id, iccid, status, holder_user_id, batch_id')
      .eq('workspace_id', workspace_id)
      .eq('iccid', iccidValidation.normalized)
      .maybeSingle();

    if (existing) {
      return errorResponse(
        `This SIM is already recorded (status: ${existing.status}). Find it in the inventory.`,
        409,
        'DUPLICATE_ICCID'
      );
    }

    // Network prefix warning (non-blocking)
    const warnings: string[] = [];
    if (iccidValidation.warning) warnings.push(iccidValidation.warning);
    if (iccidPrefix(iccidValidation.normalized) !== '89254') {
      warnings.push(`ICCID prefix ${iccidPrefix(iccidValidation.normalized)} is not the standard Kenyan 89254`);
    }

    // Insert
    const { data: sim, error: insertErr } = await admin
      .from('sims')
      .insert({
        workspace_id,
        batch_id,
        network_id: batch.network_id,
        iccid: iccidValidation.normalized,
        msisdn,
        expiry_date,
        status: 'AWAITING_ASSIGNMENT',
        scan_method,
        scan_confidence,
        raw_scan_text,
        created_by: user.id,
      })
      .select()
      .single();

    if (insertErr) {
      // Handle unique constraint violation as a race condition
      if (insertErr.code === '23505') {
        return errorResponse('This SIM was just added by another request', 409, 'DUPLICATE_ICCID');
      }
      console.error('sims-add insert error:', insertErr);
      return errorResponse('Failed to add SIM: ' + insertErr.message, 500, 'DB_ERROR');
    }

    // Audit event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id,
        batch_id,
        sim_id: sim.id,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'SIM_ADDED',
        payload: {
          iccid: iccidValidation.normalized,
          msisdn,
          expiry_date,
          scan_method,
          scan_confidence,
          notes,
        },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      sim: {
        id: sim.id,
        iccid: sim.iccid,
        msisdn: sim.msisdn,
        expiry_date: sim.expiry_date,
        status: sim.status,
        batch_id: sim.batch_id,
        network_id: sim.network_id,
        scan_method: sim.scan_method,
        scan_confidence: sim.scan_confidence,
        created_at: sim.created_at,
      },
      warnings: warnings.length > 0 ? warnings : null,
    }, 201);
  } catch (err) {
    console.error('sims-add error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});