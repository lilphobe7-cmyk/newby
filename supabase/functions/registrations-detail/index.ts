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
    const registrationId = url.searchParams.get('registration_id');
    if (!registrationId) return errorResponse('Missing registration_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    const { data: reg, error } = await admin
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .maybeSingle();

    if (error) return errorResponse('Query failed', 500, 'DB_ERROR');
    if (!reg) return errorResponse('Registration not found', 404, 'NOT_FOUND');

    // Verify access
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', reg.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');
    if (member.role === 'SUB_AGENT' && reg.reported_by !== user.id) {
      return errorResponse('Not your registration', 403, 'NOT_YOUR_REGISTRATION');
    }

    // Fetch SIM + events
    const { data: sim } = await admin
      .from('sims')
      .select('id, iccid, msisdn, status, batch_id, network_id')
      .eq('id', reg.sim_id)
      .maybeSingle();

    const { data: events } = await admin
      .from('events')
      .select('id, action, actor_id, actor_role, payload, device_timestamp, server_timestamp, source')
      .eq('sim_id', reg.sim_id)
      .order('server_timestamp', { ascending: false })
      .limit(20);

    return successResponse({
      registration: reg,
      sim,
      events: events ?? [],
    });
  } catch (err) {
    console.error('registrations-detail error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});