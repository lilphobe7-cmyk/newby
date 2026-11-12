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
    const networkId = url.searchParams.get('network_id');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    if (!workspaceId) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Verify the caller is a member of the workspace (either role)
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    let query = admin
      .from('batches')
      .select(`
        id, reference, supplier, date_received,
        quantity_expected, quantity_scanned,
        status, notes, created_by, created_at,
        updated_at, closed_at, archived_at,
        network_id,
        network:networks (id, code, display_name)
      `, { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (networkId) query = query.eq('network_id', networkId);

    const { data, error, count } = await query;
    if (error) {
      console.error('batches-list error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    // Add computed fields
    const enriched = (data ?? []).map((b) => ({
      ...b,
      quantity_unaccounted: Math.max(0, (b.quantity_expected ?? 0) - (b.quantity_scanned ?? 0)),
      quantity_remaining: Math.max(0, (b.quantity_expected ?? 0) - (b.quantity_scanned ?? 0)),
    }));

    return successResponse({
      batches: enriched,
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('batches-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});