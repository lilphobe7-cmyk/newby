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
    const simId = url.searchParams.get('sim_id');
    const iccid = url.searchParams.get('iccid');

    if (!simId && !iccid) return errorResponse('Provide sim_id or iccid', 400, 'MISSING_FIELD');

    const admin = adminClient();

    let simQuery = admin.from('sims').select(`
      id, workspace_id, iccid, msisdn, imsi, expiry_date, status,
      holder_user_id, holder_type, batch_id, network_id,
      scan_method, scan_confidence, raw_scan_text,
      created_by, created_at, updated_at,
      expired_at, archived_at, deleted_at,
      network:networks (id, code, display_name)
    `);

    if (simId) simQuery = simQuery.eq('id', simId);
    else simQuery = simQuery.eq('iccid', iccid!);

    const { data: sim, error } = await simQuery.maybeSingle();
    if (error) {
      console.error('sim fetch error:', error);
      return errorResponse('Query failed', 500, 'DB_ERROR');
    }
    if (!sim) return errorResponse('SIM not found', 404, 'NOT_FOUND');

    // Verify access
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', sim.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');
    if (member.role === 'SUB_AGENT' && sim.holder_user_id !== user.id) {
      return errorResponse('You can only view SIMs assigned to you', 403, 'NOT_YOUR_SIM');
    }

    // Fetch batch info
    const { data: batch } = await admin
      .from('batches')
      .select('id, reference, supplier, date_received, status')
      .eq('id', sim.batch_id)
      .maybeSingle();

    // Fetch event history (last 50)
    const { data: events } = await admin
      .from('events')
      .select('id, action, actor_id, actor_role, payload, device_timestamp, server_timestamp, source')
      .eq('sim_id', sim.id)
      .order('server_timestamp', { ascending: false })
      .limit(50);

    // Fetch registration reports
    const { data: registrations } = await admin
      .from('registrations')
      .select('id, outcome, phone_number, registration_date, verification_status, reported_by, reported_at')
      .eq('sim_id', sim.id)
      .order('reported_at', { ascending: false });

    return successResponse({
      sim,
      batch,
      events: events ?? [],
      registrations: registrations ?? [],
    });
  } catch (err) {
    console.error('sims-detail error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});