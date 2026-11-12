import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'METHOD_NOT_ALLOWED');

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const userSb = userClient(authHeader);
    const { data: { user } } = await userSb.auth.getUser();
    if (!user) return errorResponse('Invalid session', 401, 'UNAUTHORIZED');

    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (!raw || raw.trim() === '') return errorResponse('Empty body', 400, 'EMPTY_BODY');
      body = JSON.parse(raw);
    } catch {
      return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
    }

    const missing = requireFields(body, ['registration_id', 'reason']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const registration_id = String(body.registration_id).trim();
    const reason = String(body.reason).trim();

    const admin = adminClient();

    // Fetch the registration
    const { data: reg, error: regErr } = await admin
      .from('registrations')
      .select('id, workspace_id, sim_id, reported_by, outcome, reported_at, declined_at, verification_status')
      .eq('id', registration_id)
      .maybeSingle();

    if (regErr) return errorResponse('Fetch failed', 500, 'DB_ERROR');
    if (!reg) return errorResponse('Registration not found', 404, 'NOT_FOUND');
    if (reg.declined_at) return errorResponse('Registration is already declined', 409, 'ALREADY_DECLINED');
    if (reg.verification_status === 'VERIFIED') {
      return errorResponse('Cannot decline a verified registration', 409, 'ALREADY_VERIFIED');
    }

    // Verify caller permissions
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', reg.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    // Sub-agent can only decline their own report
    if (member.role === 'SUB_AGENT' && reg.reported_by !== user.id) {
      return errorResponse('You can only decline your own registration reports', 403, 'NOT_YOUR_REPORT');
    }

    // 15-minute correction window (sub-agent only — main agent can decline anytime)
    if (member.role === 'SUB_AGENT') {
      const reportedAt = new Date(reg.reported_at).getTime();
      const now = Date.now();
      const fifteenMinutes = 15 * 60 * 1000;
      if (now - reportedAt > fifteenMinutes) {
        return errorResponse(
          'The 15-minute correction window has passed. Ask the main agent to reverse this.',
          409,
          'CORRECTION_WINDOW_EXPIRED'
        );
      }
    }

    const now = new Date().toISOString();

    // Mark the registration as declined
    await admin
      .from('registrations')
      .update({
        declined_at: now,
        decline_reason: reason,
        verification_status: 'REJECTED',
      })
      .eq('id', registration_id);

    // Reset the SIM back to ASSIGNED
    await admin
      .from('sims')
      .update({
        status: 'ASSIGNED',
        registration_verified_at: null,
        registration_verified_by: null,
      })
      .eq('id', reg.sim_id);

    // Log event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: reg.workspace_id,
        sim_id: reg.sim_id,
        actor_id: user.id,
        actor_role: member.role,
        action: 'REGISTRATION_REVERSED',
        payload: { registration_id, reason },
        device_timestamp: now,
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      registration_id,
      sim_id: reg.sim_id,
      message: 'Registration declined. SIM is back in Active batch.',
    });
  } catch (err) {
    console.error('registrations-decline error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});