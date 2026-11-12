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
    const assignmentId = url.searchParams.get('assignment_id');
    if (!assignmentId) return errorResponse('Missing assignment_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    const { data: assignment, error } = await admin
      .from('assignments')
      .select('id, workspace_id, assigned_by, assigned_to, quantity, status, assigned_at, acknowledged_at, returned_at, returned_to, notes')
      .eq('id', assignmentId)
      .maybeSingle();

    if (error) {
      console.error('assignment fetch error:', error);
      return errorResponse('Query failed', 500, 'DB_ERROR');
    }
    if (!assignment) return errorResponse('Assignment not found', 404, 'NOT_FOUND');

    // Verify access
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', assignment.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');
    if (member.role === 'SUB_AGENT' && assignment.assigned_to !== user.id) {
      return errorResponse('Not your assignment', 403, 'NOT_YOUR_ASSIGNMENT');
    }

    // Fetch SIMs
    const { data: links } = await admin
      .from('assignment_sims')
      .select('sim_id')
      .eq('assignment_id', assignmentId);

    const simIds = (links ?? []).map((l) => l.sim_id);

    let sims: any[] = [];
    if (simIds.length > 0) {
      const { data } = await admin
        .from('sims')
        .select('id, iccid, msisdn, status, expiry_date, network_id')
        .in('id', simIds);
      sims = data ?? [];
    }

    return successResponse({
      assignment,
      sims,
      sim_count: sims.length,
    });
  } catch (err) {
    console.error('assignments-detail error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});