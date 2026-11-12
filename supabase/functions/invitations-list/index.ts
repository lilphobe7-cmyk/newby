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

    if (!workspaceId) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Verify caller is main agent
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Forbidden', 403, 'FORBIDDEN');
    }

    // Fetch invitations (no auth.users join — that was causing the 500)
    let query = admin
      .from('invitations')
      .select('id, status, expires_at, used_at, revoked_at, created_at, used_by_user_id, created_by, metadata')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data: invitations, error } = await query;
    if (error) {
      console.error('invitations query error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    // Enrich with user info (separate call, avoids the join issue)
    const userIds = Array.from(new Set(
      (invitations ?? [])
        .flatMap((i) => [i.used_by_user_id, i.created_by])
        .filter((id): id is string => !!id)
    ));

    const userMap: Record<string, { email: string | null; full_name: string | null }> = {};

    if (userIds.length > 0) {
      const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const { data: members } = await admin
        .from('workspace_members')
        .select('user_id, display_name')
        .in('user_id', userIds);

      for (const id of userIds) {
        const au = authUsers?.users?.find((u) => u.id === id);
        const wm = members?.find((r) => r.user_id === id);
        userMap[id] = {
          email: au?.email ?? null,
          full_name: wm?.display_name ?? (au?.user_metadata?.full_name as string) ?? null,
        };
      }
    }

    const enriched = (invitations ?? []).map((inv) => ({
      ...inv,
      used_by: inv.used_by_user_id ? userMap[inv.used_by_user_id] ?? null : null,
      created_by_user: inv.created_by ? userMap[inv.created_by] ?? null : null,
    }));

    return successResponse({ invitations: enriched });
  } catch (err) {
    console.error('invitations-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});