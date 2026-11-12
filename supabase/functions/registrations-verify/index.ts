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

    const missing = requireFields(body, ['registration_id', 'decision']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const registration_id = String(body.registration_id).trim();
    const decision = String(body.decision).trim().toUpperCase(); // VERIFIED or REJECTED
    const notes = body.notes ? String(body.notes).trim() : null;
    const verification_source = body.verification_source ? String(body.verification_source).trim() : 'MANUAL_MAIN_AGENT';

    if (!['VERIFIED', 'REJECTED'].includes(decision)) {
      return errorResponse('decision must be VERIFIED or REJECTED', 400, 'INVALID_DECISION');
    }

    const admin = adminClient();

    // Fetch the registration
    const { data: reg, error: regErr } = await admin
      .from('registrations')
      .select('id, workspace_id, sim_id, outcome, reported_by, verification_status')
      .eq('id', registration_id)
      .maybeSingle();

    if (regErr) return errorResponse('Fetch failed', 500, 'DB_ERROR');
    if (!reg) return errorResponse('Registration not found', 404, 'NOT_FOUND');

    // Verify caller is MAIN_AGENT
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', reg.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member || member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can verify registrations', 403, 'FORBIDDEN');
    }

    if (reg.verification_status !== 'UNVERIFIED') {
      return errorResponse(
        `Registration is already ${reg.verification_status}`,
        409,
        'ALREADY_VERIFIED'
      );
    }

    // Update the registration
    const newVerificationStatus = decision;
    const { error: updateErr } = await admin
      .from('registrations')
      .update({
        verification_status: newVerificationStatus,
        verified_by: user.id,
        verified_at: new Date().toISOString(),
        verification_source,
        verification_notes: notes,
      })
      .eq('id', registration_id);

    if (updateErr) {
      console.error('Verification update error:', updateErr);
      return errorResponse('Failed to verify: ' + updateErr.message, 500, 'DB_ERROR');
    }

    // Update the SIM status
    const newSimStatus = decision === 'VERIFIED' ? 'VERIFIED_REGISTERED' : 'REGISTRATION_FAILED';
    await admin
      .from('sims')
      .update({
        status: newSimStatus,
        registration_verified_at: decision === 'VERIFIED' ? new Date().toISOString() : null,
        registration_verified_by: verification_source,
      })
      .eq('id', reg.sim_id);

    // Log the event
    try {
      await admin.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: reg.workspace_id,
        sim_id: reg.sim_id,
        actor_id: user.id,
        actor_role: 'MAIN_AGENT',
        action: decision === 'VERIFIED' ? 'REGISTRATION_VERIFIED' : 'REGISTRATION_REJECTED',
        payload: { registration_id, decision, notes, verification_source },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      });
    } catch (evtErr) {
      console.error('Event insert error (non-fatal):', evtErr);
    }

    return successResponse({
      registration_id,
      verification_status: newVerificationStatus,
      sim_status: newSimStatus,
      message: decision === 'VERIFIED' ? 'Registration verified.' : 'Registration rejected.',
    });
  } catch (err) {
    console.error('registrations-verify error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});