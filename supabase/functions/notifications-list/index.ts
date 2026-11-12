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
    const onlyUnread = url.searchParams.get('unread') === 'true';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    const admin = adminClient();

    let query = admin
      .from('notifications')
      .select('id, workspace_id, type, title, body, payload, read_at, created_at', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (onlyUnread) {
      query = query.is('read_at', null);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error('notifications fetch error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    // Count unread separately
    const { count: unreadCount } = await admin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null);

    return successResponse({
      notifications: data ?? [],
      total: count ?? 0,
      unread: unreadCount ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('notifications-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});