import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const supabase = userClient(authHeader);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) return errorResponse('Invalid session', 401, 'UNAUTHORIZED');

    // Fetch memberships (RLS allows user to see their own)
    const { data: memberships } = await supabase
      .from('workspace_members')
      .select(`
        workspace_id,
        role,
        display_name,
        joined_at,
        workspaces (id, name, business_name)
      `)
      .eq('user_id', user.id)
      .is('removed_at', null);

    return successResponse({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name ?? null,
        created_at: user.created_at,
      },
      memberships: memberships ?? [],
    });
  } catch (err) {
    console.error('me error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});