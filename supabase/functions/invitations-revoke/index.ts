import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const userSb = userClient(authHeader);
    const { data: { user } } = await userSb.auth.getUser();
    if (!user) return errorResponse('Invalid session', 401, 'UNAUTHORIZED');

    const body = await req.json().catch(() => ({}));
    const invitationId = body.invitation_id;
    if (!invitationId) return errorResponse('Missing invitation_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Fetch the invitation
    const { data: invitation, error: fetchErr } = await admin
      .from('invitations')
      .select('id, workspace_id, status')
      .eq('id', invitationId)
      .maybeSingle();

    if (fetchErr) return errorResponse('Fetch failed: ' + fetchErr.message, 500, 'DB_ERROR');
    if (!invitation) return errorResponse('Invitation not found', 404, 'NOT_FOUND');
    if (invitation.status !== 'PENDING') {
      return errorResponse(
        `Cannot revoke an invitation with status ${invitation.status}`,
        409,
        'INVALID_STATUS'
      );
    }

    // Verify caller is MAIN_AGENT of that workspace
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', invitation.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Forbidden', 403, 'FORBIDDEN');
    }

    // Revoke
    const { error: updateErr } = await admin
      .from('invitations')
      .update({ status: 'REVOKED', revoked_at: new Date().toISOString() })
      .eq('id', invitationId)
      .eq('status', 'PENDING'); // optimistic lock

    if (updateErr) return errorResponse('Revoke failed: ' + updateErr.message, 500, 'DB_ERROR');

    // Audit
    await admin.from('events').insert({
      event_id: crypto.randomUUID(),
      workspace_id: invitation.workspace_id,
      actor_id: user.id,
      actor_role: 'MAIN_AGENT',
      action: 'INVITATION_REVOKED',
      payload: { invitation_id: invitationId },
      device_timestamp: new Date().toISOString(),
      source: 'APP',
    });

    return successResponse({ message: 'Invitation revoked' });
  } catch (err) {
    console.error('invitations-revoke error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});