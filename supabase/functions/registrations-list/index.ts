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
      .from('registrations')
      .select(`
        id, sim_id, outcome, phone_number, registration_date,
        verification_status, reported_by, reported_at,
        verified_at, verification_source, notes
      `, { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('reported_at', { ascending: false });

    if (member.role === 'SUB_AGENT') {
      query = query.eq('reported_by', user.id);
    }

    const status = url.searchParams.get('verification_status');
    const outcome = url.searchParams.get('outcome');
    const simId = url.searchParams.get('sim_id');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    if (status) query = query.eq('verification_status', status);
    if (outcome) query = query.eq('outcome', outcome);
    if (simId) query = query.eq('sim_id', simId);

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) {
      console.error('registrations-list error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    return successResponse({
      registrations: data ?? [],
      total: count ?? 0,
      limit,
      offset,
      viewer_role: member.role,
    });
  } catch (err) {
    console.error('registrations-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});