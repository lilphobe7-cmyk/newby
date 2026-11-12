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

    const missing = requireFields(body, ['workspace_id', 'user_id']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const workspaceId = String(body.workspace_id).trim();
    const targetUserId = String(body.user_id).trim();
    const reason = body.reason ? String(body.reason).trim() : null;
    const reassignSimsToMainAgent = body.reassign_sims !== false; // default true

    if (targetUserId === user.id) {
      return errorResponse('You cannot remove yourself', 400, 'SELF_REMOVAL');
    }

    const admin = adminClient();

    // Verify caller is MAIN_AGENT
    const { data: caller } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!caller || caller.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can remove members', 403, 'FORBIDDEN');
    }

    // Fetch target member
    const { data: target } = await admin
      .from('workspace_members')
      .select('user_id, role, display_name, removed_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!target) return errorResponse('Member not found', 404, 'NOT_FOUND');
    if (target.removed_at) {
      return errorResponse('Member is already removed', 409, 'ALREADY_REMOVED');
    }

    // Count SIMs currently held by the target
    const { count: heldSims } = await admin
      .from('sims')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('holder_user_id', targetUserId)
      .is('deleted_at', null);

    // ---- REASSIGN SIMS (optional) ----
    let reassigned = 0;
    if (reassignSimsToMainAgent && (heldSims ?? 0) > 0) {
      const { data: updated, error: reassignErr } = await admin
        .from('sims')
        .update({
          holder_user_id: user.id,
          holder_type: 'MAIN_AGENT',
          status: 'RETURNED',
        })
        .eq('workspace_id', workspaceId)
        .eq('holder_user_id', targetUserId)
        .is('deleted_at', null)
        .select('id');

      if (reassignErr) {
        console.error('Reassign error:', reassignErr);
        return errorResponse('Failed to reassign SIMs: ' + reassignErr.message, 500, 'DB_ERROR');
      }
      reassigned = updated?.length ?? 0;
    }

    // ---- REMOVE MEMBER (soft delete) ----
    const { error: removeErr } = await admin
      .from('workspace_members')
      .update({
        removed_at: new Date().toISOString(),
        removed_by: user.id,
        removal_reason: reason,
      })
      .eq('workspace_id', workspaceId)
      .eq('user_id', targetUserId);

    if (removeErr) {
      console.error('Remove error:', removeErr);
      return errorResponse('Failed to remove member: ' + removeErr.message, 500, 'DB_ERROR');
    }

    // ---- LOG EVENT ----
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: workspaceId,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: 'USER_REMOVED_FROM_WORKSPACE',
        payload: {
          removed_user_id: targetUserId,
          removed_user_name: target.display_name,
          reason,
          sims_reassigned: reassigned,
        },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      removed_user_id: targetUserId,
      removed_user_name: target.display_name,
      sims_reassigned: reassigned,
      message: `${target.display_name ?? 'Sub-agent'} has been removed from the workspace.${reassigned > 0 ? ` ${reassigned} SIM(s) reassigned to you.` : ''}`,
    });
  } catch (err) {
    console.error('workspace-member-remove error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});