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

    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspace_id');
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    if (!workspaceId) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    let query = admin
      .from('assignments')
      .select(`
        id, workspace_id, assigned_by, assigned_to, quantity,
        status, assigned_at, acknowledged_at, returned_at, notes
      `, { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .order('assigned_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Sub-agent sees only their own assignments
    if (member.role === 'SUB_AGENT') {
      query = query.eq('assigned_to', user.id);
    }

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) {
      console.error('assignments-list error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    return successResponse({
      assignments: data ?? [],
      total: count ?? 0,
      limit,
      offset,
      viewer_role: member.role,
    });
  } catch (err) {
    console.error('assignments-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});