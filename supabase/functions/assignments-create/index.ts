import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';

const MAX_ASSIGNMENT_SIZE = 500;

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

    const missing = requireFields(body, ['workspace_id', 'assigned_to', 'sim_ids']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const workspace_id = String(body.workspace_id).trim();
    const assigned_to = String(body.assigned_to).trim();
    const sim_ids = body.sim_ids as string[] | undefined;
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!Array.isArray(sim_ids) || sim_ids.length === 0) {
      return errorResponse('sim_ids must be a non-empty array', 400, 'MISSING_SIM_IDS');
    }
    if (sim_ids.length > MAX_ASSIGNMENT_SIZE) {
      return errorResponse(
        `Maximum ${MAX_ASSIGNMENT_SIZE} SIMs per assignment (got ${sim_ids.length})`,
        413,
        'ASSIGNMENT_TOO_LARGE'
      );
    }
    if (assigned_to === user.id) {
      return errorResponse('You cannot assign SIMs to yourself', 400, 'SELF_ASSIGNMENT');
    }

    const admin = adminClient();

    // Verify caller is MAIN_AGENT
    const { data: caller } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!caller || caller.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can assign SIMs', 403, 'FORBIDDEN');
    }

    // Verify target user is a SUB_AGENT in this workspace
    const { data: target } = await admin
      .from('workspace_members')
      .select('user_id, role, display_name')
      .eq('workspace_id', workspace_id)
      .eq('user_id', assigned_to)
      .eq('role', 'SUB_AGENT')
      .is('removed_at', null)
      .maybeSingle();

    if (!target) {
      return errorResponse('Target user is not an active sub-agent in this workspace', 404, 'SUB_AGENT_NOT_FOUND');
    }

    // Fetch the SIMs to verify eligibility
    const { data: sims, error: simErr } = await admin
      .from('sims')
      .select('id, iccid, status, holder_user_id, workspace_id, batch_id')
      .in('id', sim_ids);

    if (simErr) {
      console.error('SIM fetch error:', simErr);
      return errorResponse('Failed to fetch SIMs: ' + simErr.message, 500, 'DB_ERROR');
    }

    if (!sims || sims.length !== sim_ids.length) {
      const foundIds = new Set((sims ?? []).map((s) => s.id));
      const missingIds = sim_ids.filter((id) => !foundIds.has(id));
      return errorResponse(
        `Some SIMs not found: ${missingIds.length} missing`,
        404,
        'SIMS_NOT_FOUND',
      );
    }

    // Verify all SIMs belong to this workspace and are assignable
    const invalid: Array<{ id: string; iccid: string; reason: string }> = [];

    for (const sim of sims) {
      if (sim.workspace_id !== workspace_id) {
        invalid.push({ id: sim.id, iccid: sim.iccid, reason: 'Not in this workspace' });
        continue;
      }
      const assignableStatuses = ['AWAITING_ASSIGNMENT', 'RETURNED', 'NOT_YET_REGISTERED'];
      if (!assignableStatuses.includes(sim.status)) {
        invalid.push({
          id: sim.id,
          iccid: sim.iccid,
          reason: `Status is ${sim.status}, not assignable`,
        });
      }
    }

    if (invalid.length > 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `${invalid.length} SIM(s) cannot be assigned`,
            code: 'INVALID_SIMS',
            details: { invalid },
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // ---- CREATE THE ASSIGNMENT ----
    // sim_id is nullable after the assignment_sims migration, so we pass null here
    const { data: assignment, error: aErr } = await admin
      .from('assignments')
      .insert({
        workspace_id,
        sim_id: null,
        assigned_by: user.id,
        assigned_to,
        quantity: sims.length,
        status: 'PENDING_ACK',
        notes,
      })
      .select()
      .single();

    if (aErr) {
      console.error('Assignment insert error:', aErr);
      return errorResponse('Failed to create assignment: ' + aErr.message, 500, 'DB_ERROR');
    }

    // ---- LINK SIMs TO THE ASSIGNMENT via assignment_sims ----
    const linkRows = sim_ids.map((simId) => ({
      assignment_id: assignment.id,
      sim_id: simId,
    }));

    const { error: linkErr } = await admin
      .from('assignment_sims')
      .insert(linkRows);

    if (linkErr) {
      // Roll back the assignment
      await admin.from('assignments').delete().eq('id', assignment.id);
      console.error('Link insert error:', linkErr);
      return errorResponse('Failed to link SIMs: ' + linkErr.message, 500, 'DB_ERROR');
    }

    // ---- UPDATE EACH SIM (holder + status) ----
    const { error: updateErr } = await admin
      .from('sims')
      .update({
        holder_user_id: assigned_to,
        holder_type: 'SUB_AGENT',
        status: 'ASSIGNED',
      })
      .in('id', sim_ids);

    if (updateErr) {
      // Roll back assignment_sims and assignment
      await admin.from('assignment_sims').delete().eq('assignment_id', assignment.id);
      await admin.from('assignments').delete().eq('id', assignment.id);
      console.error('SIM update error:', updateErr);
      return errorResponse('Failed to update SIMs: ' + updateErr.message, 500, 'DB_ERROR');
    }

    // ---- LOG EVENTS ----
    const eventRows = sims.map((sim) => ({
      event_id: crypto.randomUUID(),
      workspace_id,
      sim_id: sim.id,
      batch_id: sim.batch_id,
      actor_id: user.id,
      actor_role: 'MAIN_AGENT',
      action: 'SIM_ASSIGNED',
      payload: {
        assignment_id: assignment.id,
        assigned_to,
        assigned_to_name: target.display_name,
        notes,
      },
      device_timestamp: new Date().toISOString(),
      source: 'APP',
    }));

    try {
      await admin.from('events').insert(eventRows);
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      assignment: {
        id: assignment.id,
        workspace_id: assignment.workspace_id,
        assigned_by: assignment.assigned_by,
        assigned_to: assignment.assigned_to,
        assigned_to_name: target.display_name,
        quantity: assignment.quantity,
        status: assignment.status,
        notes: assignment.notes,
        assigned_at: assignment.assigned_at,
      },
      sims_assigned: sims.length,
      message: `${sims.length} SIM(s) assigned. Awaiting acknowledgment from ${target.display_name}.`,
    }, 201);
  } catch (err) {
    console.error('assignments-create error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});