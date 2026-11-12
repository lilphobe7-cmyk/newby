import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { generateToken, sha256Hex } from '../_shared/crypto.ts';

const DEFAULT_TTL_HOURS = 24;
const MAX_ACTIVE_INVITATIONS = 50;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const userSb = userClient(authHeader);
    const { data: { user }, error: userErr } = await userSb.auth.getUser();
    if (userErr || !user) return errorResponse('Invalid session', 401, 'UNAUTHORIZED');

    const body = await req.json().catch(() => ({}));
    const workspaceId = body.workspace_id;
    const ttlHours = typeof body.ttl_hours === 'number' ? body.ttl_hours : DEFAULT_TTL_HOURS;

    if (!workspaceId) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');
    if (ttlHours < 1 || ttlHours > 168) {
      return errorResponse('ttl_hours must be between 1 and 168 (7 days)', 400, 'INVALID_TTL');
    }

    const admin = adminClient();

    // 1. Verify the caller is the MAIN_AGENT of this workspace
    const { data: member, error: memberErr } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (memberErr) return errorResponse('Membership check failed', 500, 'DB_ERROR');
    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can create invitations', 403, 'FORBIDDEN');
    }

    // 2. Rate limit — cap active pending invitations per workspace
    const { count: activeCount } = await admin
      .from('invitations')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'PENDING');

    if ((activeCount ?? 0) >= MAX_ACTIVE_INVITATIONS) {
      return errorResponse(
        'Too many active invitations. Revoke some before creating more.',
        429,
        'TOO_MANY_INVITATIONS'
      );
    }

    // 3. Generate the token and hash it
    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

    // 4. Insert the invitation
    const { data: invitation, error: invErr } = await admin
      .from('invitations')
      .insert({
        workspace_id: workspaceId,
        created_by: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        metadata: { ttl_hours: ttlHours },
      })
      .select('id, expires_at')
      .single();

    if (invErr) return errorResponse('Failed to create invitation: ' + invErr.message, 500, 'DB_ERROR');

    // 5. Build the shareable links
    const webUrl = `https://simflow.app/join?token=${rawToken}`;
    const deepLink = `simflow://join?token=${rawToken}`;

    // 6. Audit event
    await admin.from('events').insert({
      event_id: crypto.randomUUID(),
      workspace_id: workspaceId,
      actor_id: user.id,
      actor_role: 'MAIN_AGENT',
      action: 'INVITATION_CREATED',
      payload: { invitation_id: invitation.id, expires_at: expiresAt, ttl_hours: ttlHours },
      device_timestamp: new Date().toISOString(),
      source: 'APP',
    });

    return successResponse({
      invitation_id: invitation.id,
      token: rawToken,
      web_url: webUrl,
      deep_link: deepLink,
      expires_at: invitation.expires_at,
      share_message:
        `Join my SimFlow workspace. Use this link to sign up as a sub-agent:\n${webUrl}\n\n` +
        `This link expires on ${new Date(invitation.expires_at).toLocaleString()}.`,
    }, 201);
  } catch (err) {
    console.error('invitations-create error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});