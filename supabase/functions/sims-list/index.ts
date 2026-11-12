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

    // Verify membership
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    let query = admin
      .from('sims')
      .select(`
        id, iccid, msisdn, imsi, expiry_date, status,
        holder_user_id, holder_type,
        batch_id, network_id, scan_method, created_at,
        deleted_at, archived_at,
        network:networks (id, code, display_name)
      `, { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);

    // Sub-agent: only own SIMs
    if (member.role === 'SUB_AGENT') {
      query = query.eq('holder_user_id', user.id);
    }

    // Optional filters
    const status = url.searchParams.get('status');
    const batchId = url.searchParams.get('batch_id');
    const networkId = url.searchParams.get('network_id');
    const holderId = url.searchParams.get('holder_user_id');
    const search = url.searchParams.get('search');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 500);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    if (status) query = query.eq('status', status);
    if (batchId) query = query.eq('batch_id', batchId);
    if (networkId) query = query.eq('network_id', networkId);
    if (holderId) query = query.eq('holder_user_id', holderId);
    if (search) {
      // Search by ICCID or MSISDN
      query = query.or(`iccid.ilike.%${search}%,msisdn.ilike.%${search}%`);
    }

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) {
      console.error('sims-list error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    return successResponse({
      sims: data ?? [],
      total: count ?? 0,
      limit,
      offset,
      viewer_role: member.role,
    });
  } catch (err) {
    console.error('sims-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});