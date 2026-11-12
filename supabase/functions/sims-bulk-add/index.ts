import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { validateIccid, iccidPrefix } from '../_shared/iccid.ts';
import { normalizeMsisdn } from '../_shared/msisdn.ts';
import { parseExpiry } from '../_shared/expiry.ts';

const MAX_BATCH_SIZE = 500;

interface SimInput {
  iccid: string;
  msisdn?: string | null;
  expiry_date?: string | null;
  scan_method?: string;
  scan_confidence?: Record<string, number> | null;
  raw_scan_text?: string | null;
  notes?: string | null;
}

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

    const workspace_id = String(body.workspace_id ?? '').trim();
    const batch_id = String(body.batch_id ?? '').trim();
    const simsInput = body.sims as SimInput[] | undefined;

    if (!workspace_id) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');
    if (!batch_id) return errorResponse('Missing batch_id', 400, 'MISSING_FIELD');
    if (!Array.isArray(simsInput) || simsInput.length === 0) {
      return errorResponse('sims must be a non-empty array', 400, 'MISSING_SIMS');
    }
    if (simsInput.length > MAX_BATCH_SIZE) {
      return errorResponse(
        `Maximum ${MAX_BATCH_SIZE} SIMs per batch (got ${simsInput.length})`,
        413,
        'BATCH_TOO_LARGE'
      );
    }

    const admin = adminClient();

    // Verify main agent
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

    // Verify batch
    const { data: batch } = await admin
      .from('batches')
      .select('id, workspace_id, network_id, status')
      .eq('id', batch_id)
      .maybeSingle();

    if (!batch) return errorResponse('Batch not found', 404, 'BATCH_NOT_FOUND');
    if (batch.workspace_id !== workspace_id) {
      return errorResponse('Batch mismatch', 403, 'BATCH_MISMATCH');
    }
    if (batch.status !== 'OPEN') {
      return errorResponse(`Batch is ${batch.status}, not OPEN`, 409, 'BATCH_NOT_OPEN');
    }

    // ---- VALIDATE ALL SIMs FIRST ----
    const validated: Array<{
      iccid: string;
      msisdn: string | null;
      expiry_date: string | null;
      scan_method: string;
      scan_confidence: Record<string, number> | null;
      raw_scan_text: string | null;
      warnings: string[];
    }> = [];

    const errors: Array<{ index: number; iccid: string; reason: string }> = [];
    const seenIccidsInRequest = new Set<string>();

    for (let i = 0; i < simsInput.length; i++) {
      const item = simsInput[i];
      const rawIccid = item.iccid ? String(item.iccid).trim() : '';

      if (!rawIccid) {
        errors.push({ index: i, iccid: '', reason: 'Missing ICCID' });
        continue;
      }

      const iccidValidation = validateIccid(rawIccid);

      if (!iccidValidation.valid_length) {
        errors.push({
          index: i,
          iccid: iccidValidation.normalized,
          reason: `Invalid length (${iccidValidation.normalized.length} digits)`,
        });
        continue;
      }

      // Check for duplicates WITHIN the request
      if (seenIccidsInRequest.has(iccidValidation.normalized)) {
        errors.push({
          index: i,
          iccid: iccidValidation.normalized,
          reason: 'Duplicate ICCID within this request',
        });
        continue;
      }
      seenIccidsInRequest.add(iccidValidation.normalized);

      let msisdn: string | null = null;
      if (item.msisdn) {
        msisdn = normalizeMsisdn(String(item.msisdn));
        if (!msisdn) {
          errors.push({
            index: i,
            iccid: iccidValidation.normalized,
            reason: `Invalid MSISDN: ${item.msisdn}`,
          });
          continue;
        }
      }

      let expiry_date: string | null = null;
      if (item.expiry_date) {
        expiry_date = parseExpiry(String(item.expiry_date));
        if (!expiry_date) {
          errors.push({
            index: i,
            iccid: iccidValidation.normalized,
            reason: `Invalid expiry: ${item.expiry_date}`,
          });
          continue;
        }
      }

      const warnings: string[] = [];
      if (iccidValidation.warning) warnings.push(iccidValidation.warning);
      if (iccidPrefix(iccidValidation.normalized) !== '89254') {
        warnings.push(`Non-standard prefix ${iccidPrefix(iccidValidation.normalized)}`);
      }

      validated.push({
        iccid: iccidValidation.normalized,
        msisdn,
        expiry_date,
        scan_method: item.scan_method ?? 'CAMERA_AUTO',
        scan_confidence: item.scan_confidence ?? null,
        raw_scan_text: item.raw_scan_text ?? null,
        warnings,
      });
    }

    if (errors.length > 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Validation failed for ${errors.length} SIM(s)`,
            code: 'VALIDATION_FAILED',
            details: { errors },
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // ---- CHECK DB DUPLICATES ----
    const iccids = validated.map((v) => v.iccid);
    const { data: existing } = await admin
      .from('sims')
      .select('iccid, status, batch_id')
      .eq('workspace_id', workspace_id)
      .in('iccid', iccids);

    if (existing && existing.length > 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `${existing.length} SIM(s) already exist in this workspace`,
            code: 'DUPLICATE_ICCID',
            details: { duplicates: existing },
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // ---- INSERT ALL ----
    const rows = validated.map((v) => ({
      workspace_id,
      batch_id,
      network_id: batch.network_id,
      iccid: v.iccid,
      msisdn: v.msisdn,
      expiry_date: v.expiry_date,
      status: 'AWAITING_ASSIGNMENT',
      scan_method: v.scan_method,
      scan_confidence: v.scan_confidence,
      raw_scan_text: v.raw_scan_text,
      created_by: user.id,
    }));

    const { data: inserted, error: insertErr } = await admin
      .from('sims')
      .insert(rows)
      .select('id, iccid, msisdn, expiry_date, status, batch_id');

    if (insertErr) {
      console.error('sims-bulk-add error:', insertErr);
      return errorResponse('Failed to insert SIMs: ' + insertErr.message, 500, 'DB_ERROR');
    }

    // Audit event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id,
        batch_id,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'SIM_ADDED',
        payload: { count: inserted?.length ?? 0, bulk: true },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      added: inserted?.length ?? 0,
      sims: inserted ?? [],
      warnings: validated
        .map((v, i) => ({ iccid: v.iccid, warnings: v.warnings }))
        .filter((x) => x.warnings.length > 0),
    }, 201);
  } catch (err) {
    console.error('sims-bulk-add error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});