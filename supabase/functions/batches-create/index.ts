import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';

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

    const missing = requireFields(body, ['workspace_id', 'network_id', 'reference']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const workspace_id = String(body.workspace_id).trim();
    const network_id = String(body.network_id).trim();
    const reference = String(body.reference).trim();
    const supplier = body.supplier ? String(body.supplier).trim() : null;
    const date_received = body.date_received ? String(body.date_received).trim() : null;
    const quantity_expected = body.quantity_expected !== undefined ? Number(body.quantity_expected) : 0;
    const notes = body.notes ? String(body.notes).trim() : null;

    if (quantity_expected < 0 || !Number.isFinite(quantity_expected)) {
      return errorResponse('quantity_expected must be a non-negative number', 400, 'INVALID_QUANTITY');
    }

    const admin = adminClient();

    // Verify caller is MAIN_AGENT of this workspace
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can create batches', 403, 'FORBIDDEN');
    }

    // Verify network exists and is active
    const { data: network } = await admin
      .from('networks')
      .select('id, code, is_active')
      .eq('id', network_id)
      .maybeSingle();

    if (!network) return errorResponse('Network not found', 404, 'NETWORK_NOT_FOUND');
    if (!network.is_active) return errorResponse('Network is not active', 400, 'NETWORK_INACTIVE');

    // Check for duplicate reference in this workspace
    const { data: existing } = await admin
      .from('batches')
      .select('id, reference')
      .eq('workspace_id', workspace_id)
      .eq('reference', reference)
      .maybeSingle();

    if (existing) {
      return errorResponse(
        `A batch with reference "${reference}" already exists in this workspace`,
        409,
        'DUPLICATE_REFERENCE'
      );
    }

    // Insert the batch
    const { data: batch, error: insertErr } = await admin
      .from('batches')
      .insert({
        workspace_id,
        network_id,
        reference,
        supplier,
        date_received: date_received ?? new Date().toISOString().slice(0, 10),
        quantity_expected,
        notes,
        status: 'OPEN',
        created_by: user.id,
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Batch insert error:', insertErr);
      return errorResponse('Failed to create batch: ' + insertErr.message, 500, 'DB_ERROR');
    }

    // Audit event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id,
        batch_id: batch.id,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'BATCH_CREATED',
        payload: { reference, network_id, quantity_expected },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      batch: {
        id: batch.id,
        reference: batch.reference,
        network_id: batch.network_id,
        supplier: batch.supplier,
        date_received: batch.date_received,
        quantity_expected: batch.quantity_expected,
        quantity_scanned: batch.quantity_scanned,
        status: batch.status,
        notes: batch.notes,
        created_at: batch.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('batches-create error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});