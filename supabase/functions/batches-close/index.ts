import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';

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

    const batchId = body.batch_id ? String(body.batch_id).trim() : '';
    const closeNote = body.note ? String(body.note).trim() : null;
    const forceClose = body.force === true;

    if (!batchId) return errorResponse('Missing batch_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Fetch the batch
    const { data: batch, error: fetchErr } = await admin
      .from('batches')
      .select('id, workspace_id, reference, status, quantity_expected, quantity_scanned')
      .eq('id', batchId)
      .maybeSingle();

    if (fetchErr) return errorResponse('Fetch failed', 500, 'DB_ERROR');
    if (!batch) return errorResponse('Batch not found', 404, 'NOT_FOUND');
    if (batch.status === 'CLOSED') return errorResponse('Batch is already closed', 409, 'ALREADY_CLOSED');

    // Verify caller is main agent
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', batch.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can close batches', 403, 'FORBIDDEN');
    }

    // Recount SIMs to get final number
    const { count: simCount } = await admin
      .from('sims')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .is('deleted_at', null);

    const actualScanned = simCount ?? 0;
    const unaccounted = Math.max(0, (batch.quantity_expected ?? 0) - actualScanned);

    // If there's a discrepancy and force is not set, reject
    if (unaccounted > 0 && !forceClose) {
      return errorResponse(
        `Cannot close: ${unaccounted} SIM(s) unaccounted for. Expected ${batch.quantity_expected}, scanned ${actualScanned}. ` +
        `Use force=true with a note to close anyway.`,
        409,
        'DISCREPANCY'
      );
    }

    // If forcing, require a note
    if (unaccounted > 0 && forceClose && !closeNote) {
      return errorResponse('A note is required when closing with a discrepancy', 400, 'NOTE_REQUIRED');
    }

    const newStatus = unaccounted > 0 ? 'CLOSED_WITH_DISCREPANCY' : 'CLOSED';

    // Update the batch
    const { data: updated, error: updateErr } = await admin
      .from('batches')
      .update({
        status: newStatus,
        closed_at: new Date().toISOString(),
        quantity_scanned: actualScanned,
        notes: closeNote ? ((batch as any).notes ? (batch as any).notes + '\n\n[CLOSE] ' + closeNote : '[CLOSE] ' + closeNote) : (batch as any).notes,
      })
      .eq('id', batchId)
      .select()
      .single();

    if (updateErr) {
      console.error('Batch close error:', updateErr);
      return errorResponse('Failed to close: ' + updateErr.message, 500, 'DB_ERROR');
    }

    // Audit event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: batch.workspace_id,
        batch_id: batchId,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'BATCH_CREATED',
        payload: {
          action: 'CLOSED',
          expected: batch.quantity_expected,
          scanned: actualScanned,
          unaccounted,
          note: closeNote,
          forced: forceClose,
        },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      batch: updated,
      discrepancy: unaccounted > 0 ? { unaccounted, note: closeNote } : null,
    });
  } catch (err) {
    console.error('batches-close error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});