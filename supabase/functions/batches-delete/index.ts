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

    const missing = requireFields(body, ['batch_id']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const batch_id = String(body.batch_id).trim();
    const reason = body.reason ? String(body.reason).trim() : 'Manual deletion by main agent';

    const admin = adminClient();

    // Fetch the batch
    const { data: batch, error: fetchErr } = await admin
      .from('batches')
      .select('id, workspace_id, reference, quantity_scanned, archived_at')
      .eq('id', batch_id)
      .maybeSingle();

    if (fetchErr) return errorResponse('Fetch failed', 500, 'DB_ERROR');
    if (!batch) return errorResponse('Batch not found', 404, 'NOT_FOUND');
    if (batch.archived_at) return errorResponse('Batch already archived', 409, 'ALREADY_ARCHIVED');

    // Verify main agent
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', batch.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can delete batches', 403, 'FORBIDDEN');
    }

    // Count SIMs in each problematic status
    const { data: sims, error: simsErr } = await admin
      .from('sims')
      .select('id, status, holder_type, deleted_at')
      .eq('batch_id', batch_id)
      .is('deleted_at', null);

    if (simsErr) return errorResponse('SIM query failed', 500, 'DB_ERROR');

    const blockingStatuses = [
      'ASSIGNED',
      'REPORTED_REGISTERED',
      'VERIFIED_REGISTERED',
      'REGISTRATION_FAILED',
    ];
    const blocking = (sims ?? []).filter((s) => blockingStatuses.includes(s.status));

    if (blocking.length > 0) {
      return errorResponse(
        `Cannot delete batch: ${blocking.length} SIM(s) are assigned or registered. Return/reassign them first.`,
        409,
        'BATCH_HAS_ACTIVE_SIMS'
      );
    }

    const now = new Date().toISOString();
    const recoveryDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Tombstone for the batch itself
    const { data: tombstone } = await admin
      .from('tombstones')
      .insert({
        entity_type: 'BATCH',
        entity_id: batch.reference,
        workspace_id: batch.workspace_id,
        removed_by: user.id,
        reason: 'MISTAKEN_ENTRY',
        notes: reason,
        recoverable: true,
        recovery_deadline: recoveryDeadline,
        metadata: { batch_id: batch.id, reference: batch.reference },
      })
      .select('id')
      .single();

    // Soft-delete all deletable SIMs in this batch
    const deletableIds = (sims ?? [])
      .filter((s) => !blockingStatuses.includes(s.status))
      .map((s) => s.id);

    if (deletableIds.length > 0) {
      await admin
        .from('sims')
        .update({
          deleted_at: now,
          deletion_reason: 'Batch deleted: ' + reason,
          recoverable_until: recoveryDeadline,
        })
        .in('id', deletableIds);
    }

    // Archive the batch
    await admin
      .from('batches')
      .update({
        archived_at: now,
        status: 'CLOSED',
        notes: `[DELETED] ${reason}`,
      })
      .eq('id', batch_id);

    // Log event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: batch.workspace_id,
        batch_id: batch.id,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'BATCH_ARCHIVED',
        payload: {
          reference: batch.reference,
          reason,
          sims_deleted: deletableIds.length,
          tombstone_id: tombstone?.id,
        },
        device_timestamp: now,
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      batch_id,
      reference: batch.reference,
      sims_deleted: deletableIds.length,
      message: `Batch archived. ${deletableIds.length} SIM(s) removed. Recoverable for 24 hours.`,
      recoverable_until: recoveryDeadline,
    });
  } catch (err) {
    console.error('batches-delete error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});