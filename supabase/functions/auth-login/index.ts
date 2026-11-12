import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const missing = requireFields(body, ['email', 'password']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    );

    const { data, error } = await supabase.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (error) return errorResponse('Invalid email or password', 401, 'INVALID_CREDENTIALS');

    // Fetch roles + workspace for convenience
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: memberships } = await admin
      .from('workspace_members')
      .select('workspace_id, role, display_name')
      .eq('user_id', data.user.id)
      .is('removed_at', null);

    return successResponse({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: data.user.id,
        email: data.user.email,
        full_name: data.user.user_metadata?.full_name ?? null,
      },
      memberships: memberships ?? [],
    });
  } catch (err) {
    console.error('login error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});