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
    const role = url.searchParams.get('role'); // optional: SUB_AGENT | MAIN_AGENT
    const includeRemoved = url.searchParams.get('include_removed') === 'true';

    if (!workspaceId) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Verify caller is a member of the workspace
    const { data: caller } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!caller) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    // Fetch members with their auth.users details joined
    let query = admin
      .from('workspace_members')
      .select('user_id, role, display_name, joined_at, removed_at, removed_by, removal_reason')
      .eq('workspace_id', workspaceId)
      .order('joined_at', { ascending: true });

    if (!includeRemoved) {
      query = query.is('removed_at', null);
    }
    if (role) {
      query = query.eq('role', role);
    }

    const { data: members, error } = await query;
    if (error) {
      console.error('members fetch error:', error);
      return errorResponse('Query failed: ' + error.message, 500, 'DB_ERROR');
    }

    // Fetch user emails from auth (batched)
    const userIds = (members ?? []).map((m) => m.user_id);
    const emailMap: Record<string, string> = {};
    const phoneMap: Record<string, string | null> = {};

    if (userIds.length > 0) {
      const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
      for (const u of authUsers?.users ?? []) {
        if (userIds.includes(u.id)) {
          emailMap[u.id] = u.email ?? '';
          phoneMap[u.id] = (u.user_metadata?.phone as string) ?? null;
        }
      }
    }

    // Get SIM counts per sub-agent (useful for main agent view)
    const holderCounts: Record<string, number> = {};
    if (userIds.length > 0) {
      const { data: simRows } = await admin
        .from('sims')
        .select('holder_user_id')
        .eq('workspace_id', workspaceId)
        .in('holder_user_id', userIds)
        .is('deleted_at', null);

      for (const row of simRows ?? []) {
        if (row.holder_user_id) {
          holderCounts[row.holder_user_id] = (holderCounts[row.holder_user_id] ?? 0) + 1;
        }
      }
    }

    const enriched = (members ?? []).map((m) => ({
      user_id: m.user_id,
      role: m.role,
      display_name: m.display_name,
      email: emailMap[m.user_id] ?? null,
      phone: phoneMap[m.user_id] ?? null,
      joined_at: m.joined_at,
      removed_at: m.removed_at,
      removed_by: m.removed_by,
      removal_reason: m.removal_reason,
      sim_count: holderCounts[m.user_id] ?? 0,
    }));

    return successResponse({
      members: enriched,
      total: enriched.length,
      viewer_role: caller.role,
    });
  } catch (err) {
    console.error('workspace-members-list error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});