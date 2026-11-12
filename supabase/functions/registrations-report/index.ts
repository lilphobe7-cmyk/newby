import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';
import { normalizeMsisdn } from '../_shared/msisdn.ts';

const FAILURE_REASONS = [
  'FAILED_REJECTED',
  'FAILED_CUSTOMER_INCOMPLETE',
  'FAILED_SIM_UNREADABLE',
  'FAILED_SYSTEM_UNAVAILABLE',
  'FAILED_OTHER',
];

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

    const missing = requireFields(body, ['sim_id', 'outcome']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const sim_id = String(body.sim_id).trim();
    const outcome = String(body.outcome).trim().toUpperCase();
    const rawMsisdn = body.phone_number ? String(body.phone_number).trim() : null;
    const registration_date = body.registration_date ? String(body.registration_date).trim() : null;
    const customer_reference = body.customer_reference ? String(body.customer_reference).trim() : null;
    const notes = body.notes ? String(body.notes).trim() : null;
    const event_id = body.event_id ? String(body.event_id).trim() : crypto.randomUUID();
    const device_timestamp = body.device_timestamp ? String(body.device_timestamp).trim() : new Date().toISOString();
    const on_behalf_of = body.on_behalf_of ? String(body.on_behalf_of).trim() : null;

    const validOutcomes = ['REGISTERED', ...FAILURE_REASONS];
    if (!validOutcomes.includes(outcome)) {
      return errorResponse(
        `Invalid outcome. Must be one of: ${validOutcomes.join(', ')}`,
        400,
        'INVALID_OUTCOME'
      );
    }

    const admin = adminClient();

    const { data: sim, error: simErr } = await admin
      .from('sims')
      .select('id, workspace_id, iccid, msisdn, status, holder_user_id, holder_type, batch_id')
      .eq('id', sim_id)
      .maybeSingle();

    if (simErr) {
      console.error('SIM fetch error:', simErr);
      return errorResponse('Failed to fetch SIM', 500, 'DB_ERROR');
    }
    if (!sim) return errorResponse('SIM not found', 404, 'SIM_NOT_FOUND');

    // ---------- Authorization ----------
    const isHolder = sim.holder_user_id === user.id;
    let callerRole: 'MAIN_AGENT' | 'SUB_AGENT' | null = null;

    if (isHolder) {
      callerRole = sim.holder_type === 'MAIN_AGENT' ? 'MAIN_AGENT' : 'SUB_AGENT';
    } else if (on_behalf_of) {
      // Acting on behalf — validate
      if (sim.holder_user_id !== on_behalf_of) {
        return errorResponse('on_behalf_of does not match the SIM holder', 400, 'ON_BEHALF_MISMATCH');
      }
      const { data: callerMember } = await admin
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', sim.workspace_id)
        .eq('user_id', user.id)
        .is('removed_at', null)
        .maybeSingle();
      if (!callerMember || callerMember.role !== 'MAIN_AGENT') {
        return errorResponse('Only the main agent can act on behalf of a sub-agent', 403, 'FORBIDDEN');
      }
      callerRole = 'MAIN_AGENT';
    } else {
      return errorResponse('You do not hold this SIM', 403, 'NOT_YOUR_SIM');
    }

    const reportableStatuses = ['ASSIGNED', 'NOT_YET_REGISTERED', 'REGISTRATION_ATTEMPTED', 'REGISTRATION_FAILED'];
    if (!reportableStatuses.includes(sim.status)) {
      return errorResponse(`SIM status is ${sim.status}; cannot report registration`, 409, 'INVALID_SIM_STATUS');
    }

    let phone_number: string | null = sim.msisdn;
    if (rawMsisdn) {
      const normalized = normalizeMsisdn(rawMsisdn);
      if (!normalized) return errorResponse(`Invalid phone number: ${rawMsisdn}`, 400, 'INVALID_MSISDN');
      phone_number = normalized;
    }
    if (outcome === 'REGISTERED' && !phone_number) {
      return errorResponse('A phone number is required to mark a SIM as registered', 400, 'MSISDN_REQUIRED');
    }

    const { data: existingEvent } = await admin
      .from('events')
      .select('id')
      .eq('event_id', event_id)
      .maybeSingle();

    if (existingEvent) {
      const { data: existingReg } = await admin
        .from('registrations')
        .select('id, outcome, phone_number, reported_at, verification_status')
        .eq('sim_id', sim_id)
        .order('reported_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return successResponse({ registration: existingReg, idempotent: true, message: 'Already reported.' });
    }

    const { data: registration, error: regErr } = await admin
      .from('registrations')
      .insert({
        workspace_id: sim.workspace_id,
        sim_id,
        reported_by: user.id,
        outcome,
        phone_number,
        registration_date: registration_date ?? new Date().toISOString(),
        customer_reference,
        notes,
        verification_status: 'UNVERIFIED',
      })
      .select()
      .single();

    if (regErr) {
      console.error('Registration insert error:', regErr);
      return errorResponse('Failed to save: ' + regErr.message, 500, 'DB_ERROR');
    }

    const newStatus = outcome === 'REGISTERED' ? 'REPORTED_REGISTERED' : 'REGISTRATION_FAILED';
    await admin.from('sims').update({ status: newStatus, msisdn: phone_number }).eq('id', sim_id);

    // Log with on_behalf_of
    try {
      await admin.from('events').insert({
        event_id,
        workspace_id: sim.workspace_id,
        sim_id: sim.id,
        batch_id: sim.batch_id,
        actor_id: user.id,
        actor_role: callerRole,
        action: outcome === 'REGISTERED' ? 'REGISTRATION_REPORTED' : 'REGISTRATION_REJECTED',
        payload: { registration_id: registration.id, outcome, phone_number, customer_reference, notes, on_behalf_of },
        acted_on_behalf_of: on_behalf_of,
        device_timestamp,
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      registration: {
        id: registration.id,
        sim_id: registration.sim_id,
        outcome: registration.outcome,
        phone_number: registration.phone_number,
        reported_at: registration.reported_at,
        verification_status: registration.verification_status,
        correction_expires_at: registration.correction_expires_at,
      },
      sim_status: newStatus,
      acted_on_behalf_of: on_behalf_of,
      message: outcome === 'REGISTERED'
        ? 'Registration reported. Awaiting verification.'
        : 'Registration failure recorded.',
    }, 201);
  } catch (err) {
    console.error('registrations-report error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});