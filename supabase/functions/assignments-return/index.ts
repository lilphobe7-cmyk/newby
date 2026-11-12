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

    const missing = requireFields(body, ['sim_ids', 'reason']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const sim_ids = body.sim_ids as string[];
    const reason = String(body.reason).trim();
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!Array.isArray(sim_ids) || sim_ids.length === 0) {
      return errorResponse('sim_ids must be a non-empty array', 400, 'MISSING_SIM_IDS');
    }

    const admin = adminClient();

    // Fetch the SIMs
    const { data: sims, error: simErr } = await admin
      .from('sims')
      .select('id, workspace_id, iccid, status, holder_user_id, batch_id')
      .in('id', sim_ids);

    if (simErr) {
      console.error('SIM fetch error:', simErr);
      return errorResponse('Failed to fetch SIMs', 500, 'DB_ERROR');
    }

    if (!sims || sims.length !== sim_ids.length) {
      return errorResponse('Some SIMs not found', 404, 'SIMS_NOT_FOUND');
    }

    // All SIMs must belong to the same workspace
    const workspace_id = sims[0].workspace_id;
    if (!sims.every((s) => s.workspace_id === workspace_id)) {
      return errorResponse('SIMs belong to different workspaces', 400, 'MIXED_WORKSPACES');
    }

    // Verify caller has permission
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    // If caller is sub-agent, they must be the holder
    if (member.role === 'SUB_AGENT') {
      const notHeld = sims.filter((s) => s.holder_user_id !== user.id);
      if (notHeld.length > 0) {
        return errorResponse(
          `You cannot return ${notHeld.length} SIM(s) you don't hold`,
          403,
          'NOT_YOUR_SIMS'
        );
      }
    }

    // Find the main agent (for holder reset)
    const { data: mainAgentRow } = await admin
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspace_id)
      .eq('role', 'MAIN_AGENT')
      .is('removed_at', null)
      .maybeSingle();

    if (!mainAgentRow) return errorResponse('Workspace has no main agent', 500, 'NO_MAIN_AGENT');

    // Update all SIMs: holder back to main agent, status RETURNED
    const { error: updateErr } = await admin
      .from('sims')
      .update({
        holder_user_id: mainAgentRow.user_id,
        holder_type: 'MAIN_AGENT',
        status: 'RETURNED',
      })
      .in('id', sim_ids);

    if (updateErr) {
      console.error('Return update error:', updateErr);
      return errorResponse('Failed to return SIMs: ' + updateErr.message, 500, 'DB_ERROR');
    }

    // Log events
    const eventRows = sims.map((sim) => ({
      event_id: crypto.randomUUID(),
      workspace_id,
      sim_id: sim.id,
      batch_id: sim.batch_id,
      actor_id: user.id,
      actor_role: member.role,
      action: 'SIM_RETURNED',
      payload: { reason, notes, returned_from: sim.holder_user_id },
      device_timestamp: new Date().toISOString(),
      source: 'APP',
    }));

    try {
      await admin.from('events').insert(eventRows);
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      returned: sims.length,
      sim_ids,
      message: `${sims.length} SIM(s) returned to main agent.`,
    });
  } catch (err) {
    console.error('assignments-return error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});