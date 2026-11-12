import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { isValidEmail, isStrongPassword, requireFields } from '../_shared/validate.ts';

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'METHOD_NOT_ALLOWED');

  try {
    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (!raw || raw.trim() === '') return errorResponse('Empty body', 400, 'EMPTY_BODY');
      body = JSON.parse(raw);
    } catch {
      return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
    }

    // Accept multiple field names for the token
    const rawToken = body.token || body.invite_code || body.code || body.invitation_token;
    if (!rawToken) {
      return errorResponse('Missing field: token (or invite_code)', 400, 'MISSING_FIELD');
    }

    const missing = requireFields(body, ['email', 'password', 'full_name']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const token = String(rawToken).trim();
    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);
    const full_name = String(body.full_name).trim();

    if (!isValidEmail(email)) return errorResponse('Invalid email format', 400, 'INVALID_EMAIL');
    if (!isStrongPassword(password)) {
      return errorResponse('Password too weak', 400, 'WEAK_PASSWORD');
    }

    const supabase = adminClient();

    // Look up the invitation by token hash
    const tokenHash = await sha256Hex(token);

    const { data: invitation, error: invErr } = await supabase
      .from('invitations')
      .select('id, workspace_id, status, expires_at, created_by')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (invErr) {
      console.error('Invitation lookup error:', invErr);
      return errorResponse('Invitation lookup failed', 500, 'LOOKUP_ERROR');
    }
    if (!invitation) {
      return errorResponse(
        'Invalid invitation token. Please copy the full token from your invite link (or ask your main agent for a new link).',
        404,
        'INVITATION_NOT_FOUND'
      );
    }

    if (invitation.status === 'USED') {
      return errorResponse('This invitation has already been used. Please sign in instead.', 410, 'INVITATION_USED');
    }
    if (invitation.status === 'REVOKED') {
      return errorResponse('This invitation was revoked by the main agent.', 410, 'INVITATION_REVOKED');
    }
    if (invitation.status === 'EXPIRED') {
      return errorResponse('This invitation has expired.', 410, 'INVITATION_EXPIRED');
    }
    if (new Date(invitation.expires_at) < new Date()) {
      await supabase.from('invitations').update({ status: 'EXPIRED' }).eq('id', invitation.id);
      return errorResponse('This invitation has expired.', 410, 'INVITATION_EXPIRED');
    }

    // Create the auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return errorResponse('This email is already registered. Please sign in.', 409, 'EMAIL_TAKEN');
      }
      console.error('createUser error:', authError);
      return errorResponse(authError.message, 400, 'AUTH_ERROR');
    }

    const userId = authData.user.id;

    // Add as workspace member
    const { error: wmError } = await supabase
      .from('workspace_members')
      .insert({
        workspace_id: invitation.workspace_id,
        user_id: userId,
        role: 'SUB_AGENT',
        display_name: full_name,
      });

    if (wmError) {
      console.error('workspace_members insert error:', wmError);
      await supabase.auth.admin.deleteUser(userId);
      return errorResponse('Failed to join workspace: ' + wmError.message, 500, 'MEMBER_ERROR');
    }

    // Mark invitation as used (atomic lock)
    const { error: markErr } = await supabase
      .from('invitations')
      .update({
        status: 'USED',
        used_at: new Date().toISOString(),
        used_by_user_id: userId,
      })
      .eq('id', invitation.id)
      .eq('status', 'PENDING');

    if (markErr) {
      console.error('invitation mark-used error:', markErr);
      await supabase.auth.admin.deleteUser(userId);
      return errorResponse('Invitation was already consumed', 409, 'INVITATION_RACE');
    }

    // Log event
    try {
      await supabase.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: invitation.workspace_id,
        actor_id: userId,
        actor_role: 'SUB_AGENT',
        action: 'USER_JOINED_WORKSPACE',
        payload: { email, full_name },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      user_id: userId,
      workspace_id: invitation.workspace_id,
      email,
      message: 'Welcome to SimFlow.',
    }, 201);
  } catch (err) {
    console.error('auth-sub-agent-signup error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});