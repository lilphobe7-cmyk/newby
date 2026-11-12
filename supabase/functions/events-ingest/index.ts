import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { normalizeMsisdn } from '../_shared/msisdn.ts';

const MAX_EVENTS_PER_BATCH = 100;
const ALLOWED_ACTIONS = ['REGISTRATION_REPORTED', 'REGISTRATION_REJECTED', 'SIM_RETURNED', 'SIM_RECEIPT_ACKNOWLEDGED'];

interface IngestEvent {
  event_id: string;
  sim_id?: string;
  action: string;
  device_timestamp: string;
  payload: Record<string, unknown>;
}

interface ProcessedEvent {
  event_id: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  server_event_id?: number;
  registration_id?: string;
}

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

    const events = body.events as IngestEvent[] | undefined;
    if (!Array.isArray(events) || events.length === 0) {
      return errorResponse('events must be a non-empty array', 400, 'MISSING_EVENTS');
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
      return errorResponse(
        `Maximum ${MAX_EVENTS_PER_BATCH} events per batch (got ${events.length})`,
        413,
        'BATCH_TOO_LARGE'
      );
    }

    const admin = adminClient();
    const ingestBatchId = crypto.randomUUID();
    const results: ProcessedEvent[] = [];

    // Track event IDs already seen in this batch
    const seenEventIds = new Set<string>();

    for (const evt of events) {
      try {
        // Basic validation
        if (!evt.event_id || !evt.action || !evt.device_timestamp) {
          results.push({
            event_id: evt.event_id ?? '',
            status: 'rejected',
            reason: 'Missing required event fields',
          });
          continue;
        }

        if (seenEventIds.has(evt.event_id)) {
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: 'Duplicate event_id within this batch',
          });
          continue;
        }
        seenEventIds.add(evt.event_id);

        if (!ALLOWED_ACTIONS.includes(evt.action)) {
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: `Action ${evt.action} is not allowed for offline ingest`,
          });
          continue;
        }

        // Idempotency check: has this event already been processed?
        const { data: existing } = await admin
          .from('events')
          .select('id')
          .eq('event_id', evt.event_id)
          .maybeSingle();

        if (existing) {
          results.push({
            event_id: evt.event_id,
            status: 'duplicate',
            server_event_id: existing.id,
          });
          continue;
        }

        // Fetch the SIM (required for all these actions)
        if (!evt.sim_id) {
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: 'sim_id required',
          });
          continue;
        }

        const { data: sim } = await admin
          .from('sims')
          .select('id, workspace_id, iccid, msisdn, status, holder_user_id, holder_type, batch_id')
          .eq('id', evt.sim_id)
          .maybeSingle();

        if (!sim) {
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: 'SIM not found',
          });
          continue;
        }

        // Authorization: caller must hold the SIM or be the main agent
        const { data: member } = await admin
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', sim.workspace_id)
          .eq('user_id', user.id)
          .is('removed_at', null)
          .maybeSingle();

        if (!member) {
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: 'Not a workspace member',
          });
          continue;
        }

        if (member.role === 'SUB_AGENT' && sim.holder_user_id !== user.id) {
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: 'SIM is not held by this user',
          });
          continue;
        }

        // ---- PROCESS THE EVENT ----
        let registration_id: string | undefined;

        if (evt.action === 'REGISTRATION_REPORTED' || evt.action === 'REGISTRATION_REJECTED') {
          const payload = evt.payload ?? {};
          const outcome = evt.action === 'REGISTRATION_REPORTED' ? 'REGISTERED' : (payload.outcome as string ?? 'FAILED_OTHER');
          const rawMsisdn = payload.phone_number as string | undefined;

          let phone_number: string | null = sim.msisdn;
          if (rawMsisdn) {
            const normalized = normalizeMsisdn(rawMsisdn);
            if (normalized) phone_number = normalized;
          }

          if (outcome === 'REGISTERED' && !phone_number) {
            results.push({
              event_id: evt.event_id,
              status: 'rejected',
              reason: 'MSISDN required for REGISTERED outcome',
            });
            continue;
          }

          const { data: registration, error: regErr } = await admin
            .from('registrations')
            .insert({
              workspace_id: sim.workspace_id,
              sim_id: sim.id,
              reported_by: user.id,
              outcome,
              phone_number,
              registration_date: (payload.registration_date as string) ?? evt.device_timestamp,
              customer_reference: (payload.customer_reference as string) ?? null,
              notes: (payload.notes as string) ?? null,
              verification_status: 'UNVERIFIED',
            })
            .select('id')
            .single();

          if (regErr) {
            console.error('registration insert error:', regErr);
            results.push({
              event_id: evt.event_id,
              status: 'rejected',
              reason: 'Database insert failed',
            });
            continue;
          }

          registration_id = registration.id;

          // Update the SIM status
          const newStatus = outcome === 'REGISTERED' ? 'REPORTED_REGISTERED' : 'REGISTRATION_FAILED';
          await admin
            .from('sims')
            .update({ status: newStatus, msisdn: phone_number })
            .eq('id', sim.id);
        } else if (evt.action === 'SIM_RETURNED') {
          await admin
            .from('sims')
            .update({
              holder_user_id: sim.holder_user_id, // placeholder; a follow-up will set to main agent
              status: 'RETURNED',
            })
            .eq('id', sim.id);
        }

        // Insert the event
        const { data: insertedEvent, error: evtErr } = await admin
          .from('events')
          .insert({
            event_id: evt.event_id,
            workspace_id: sim.workspace_id,
            sim_id: sim.id,
            batch_id: sim.batch_id,
            actor_id: user.id,
            actor_role: member.role,
            action: evt.action,
            payload: { ...evt.payload, registration_id, ingest_batch_id: ingestBatchId },
            device_timestamp: evt.device_timestamp,
            source: 'OFFLINE_SYNC',
            ingest_batch_id: ingestBatchId,
          })
          .select('id')
          .single();

        if (evtErr) {
          console.error('event insert error:', evtErr);
          results.push({
            event_id: evt.event_id,
            status: 'rejected',
            reason: 'Event insert failed',
          });
          continue;
        }

        results.push({
          event_id: evt.event_id,
          status: 'accepted',
          server_event_id: insertedEvent.id,
          registration_id,
        });
      } catch (perEventErr) {
        console.error('per-event error:', perEventErr);
        results.push({
          event_id: evt.event_id,
          status: 'rejected',
          reason: perEventErr instanceof Error ? perEventErr.message : 'Unknown error',
        });
      }
    }

    const accepted = results.filter((r) => r.status === 'accepted').length;
    const duplicates = results.filter((r) => r.status === 'duplicate').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;

    return successResponse({
      ingest_batch_id: ingestBatchId,
      total: events.length,
      accepted,
      duplicates,
      rejected,
      results,
    });
  } catch (err) {
    console.error('events-ingest error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});