import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { sha256Hex } from '../_shared/crypto.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    if (!token) return errorResponse('Missing token', 400, 'MISSING_FIELD');

    const tokenHash = await sha256Hex(token);
    const admin = adminClient();

    const { data: invitation, error } = await admin
      .from('invitations')
      .select(`
        id, status, expires_at,
        workspace:workspace_id (id, name, business_name)
      `)
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error) return errorResponse('Lookup failed', 500, 'DB_ERROR');
    if (!invitation) {
      return errorResponse('Invalid invitation link', 404, 'INVITATION_NOT_FOUND');
    }

    if (invitation.status === 'USED') {
      return errorResponse(
        'This invitation has already been used. Sign in if you already have an account.',
        410,
        'INVITATION_USED'
      );
    }
    if (invitation.status === 'REVOKED') {
      return errorResponse('This invitation was revoked by the main agent.', 410, 'INVITATION_REVOKED');
    }
    if (new Date(invitation.expires_at) < new Date()) {
      return errorResponse('This invitation has expired.', 410, 'INVITATION_EXPIRED');
    }

    return successResponse({
      valid: true,
      workspace: {
        name: invitation.workspace.name,
        business_name: invitation.workspace.business_name,
      },
      expires_at: invitation.expires_at,
    });
  } catch (err) {
    console.error('invitations-resolve error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});