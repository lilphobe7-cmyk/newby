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

    const missing = requireFields(body, ['sim_id']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const sim_id = String(body.sim_id).trim();
    const reason = body.reason ? String(body.reason).trim() : 'Manual deletion by main agent';

    const admin = adminClient();

    // Fetch the SIM
    const { data: sim, error: fetchErr } = await admin
      .from('sims')
      .select('id, workspace_id, iccid, status, holder_user_id, holder_type, batch_id, deleted_at')
      .eq('id', sim_id)
      .maybeSingle();

    if (fetchErr) {
      console.error('SIM fetch error:', fetchErr);
      return errorResponse('Fetch failed', 500, 'DB_ERROR');
    }
    if (!sim) return errorResponse('SIM not found', 404, 'NOT_FOUND');
    if (sim.deleted_at) return errorResponse('SIM is already deleted', 409, 'ALREADY_DELETED');

    // Verify caller is MAIN_AGENT
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', sim.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can delete SIMs', 403, 'FORBIDDEN');
    }

    // Business rule: cannot delete a SIM held by a sub-agent
    if (sim.holder_type === 'SUB_AGENT' && sim.holder_user_id !== user.id) {
      return errorResponse(
        'This SIM is currently assigned to a sub-agent. Return it first, then delete.',
        409,
        'SIM_ASSIGNED'
      );
    }

    // Business rule: cannot delete registered SIMs
    const undeletableStatuses = ['REPORTED_REGISTERED', 'VERIFIED_REGISTERED', 'REGISTRATION_FAILED'];
    if (undeletableStatuses.includes(sim.status)) {
      return errorResponse(
        `Cannot delete a SIM with status ${sim.status}. Archive it instead.`,
        409,
        'INVALID_STATUS'
      );
    }

    const now = new Date().toISOString();
    const recoveryDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Create tombstone
    const { data: tombstone } = await admin
      .from('tombstones')
      .insert({
        entity_type: 'SIM',
        entity_id: sim.iccid,
        workspace_id: sim.workspace_id,
        removed_by: user.id,
        reason: 'MISTAKEN_ENTRY',
        notes: reason,
        recoverable: true,
        recovery_deadline: recoveryDeadline,
        metadata: { sim_id: sim.id, iccid: sim.iccid },
      })
      .select('id')
      .single();

    // Soft-delete the SIM
    const { error: delErr } = await admin
      .from('sims')
      .update({
        deleted_at: now,
        deletion_reason: reason,
        recoverable_until: recoveryDeadline,
        tombstone_id: tombstone?.id ?? null,
      })
      .eq('id', sim_id);

    if (delErr) {
      console.error('Delete error:', delErr);
      return errorResponse('Delete failed: ' + delErr.message, 500, 'DB_ERROR');
    }

    // Decrement batch counter manually (trigger doesn't fire on deleted_at updates)
    if (sim.batch_id) {
      const { data: batch } = await admin
        .from('batches')
        .select('quantity_scanned')
        .eq('id', sim.batch_id)
        .single();

      if (batch && batch.quantity_scanned > 0) {
        await admin
          .from('batches')
          .update({ quantity_scanned: batch.quantity_scanned - 1 })
          .eq('id', sim.batch_id);
      }
    }

    // Log event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: sim.workspace_id,
        sim_id: sim.id,
        batch_id: sim.batch_id,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'SIM_SOFT_DELETED',
        payload: { iccid: sim.iccid, reason, tombstone_id: tombstone?.id },
        device_timestamp: now,
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      sim_id,
      iccid: sim.iccid,
      message: 'SIM deleted. Recoverable for 24 hours.',
      recoverable_until: recoveryDeadline,
    });
  } catch (err) {
    console.error('sims-delete error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});