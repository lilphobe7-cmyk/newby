import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';

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

    const assignment_id = body.assignment_id ? String(body.assignment_id).trim() : '';
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!assignment_id) return errorResponse('Missing assignment_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Fetch the assignment
    const { data: assignment, error: aErr } = await admin
      .from('assignments')
      .select('id, workspace_id, assigned_to, status, quantity')
      .eq('id', assignment_id)
      .maybeSingle();

    if (aErr) return errorResponse('Fetch failed', 500, 'DB_ERROR');
    if (!assignment) return errorResponse('Assignment not found', 404, 'NOT_FOUND');
    if (assignment.assigned_to !== user.id) {
      return errorResponse('You can only acknowledge your own assignments', 403, 'FORBIDDEN');
    }
    if (assignment.status === 'ACKNOWLEDGED') {
      return errorResponse('Already acknowledged', 409, 'ALREADY_ACKNOWLEDGED');
    }
    if (assignment.status !== 'PENDING_ACK') {
      return errorResponse(`Cannot acknowledge assignment with status ${assignment.status}`, 409, 'INVALID_STATUS');
    }

    // Update to acknowledged
    const { error: updateErr } = await admin
      .from('assignments')
      .update({
        status: 'ACKNOWLEDGED',
        acknowledged_at: new Date().toISOString(),
        notes: notes ? (assignment as any).notes ? (assignment as any).notes + '\n[ACK] ' + notes : '[ACK] ' + notes : (assignment as any).notes,
      })
      .eq('id', assignment_id);

    if (updateErr) {
      console.error('Acknowledge error:', updateErr);
      return errorResponse('Failed to acknowledge: ' + updateErr.message, 500, 'DB_ERROR');
    }

    // Get the SIMs in this assignment
    const { data: links } = await admin
      .from('assignment_sims')
      .select('sim_id')
      .eq('assignment_id', assignment_id);

    // Log events
    if (links && links.length > 0) {
      const eventRows = links.map((link) => ({
        event_id: crypto.randomUUID(),
        workspace_id: assignment.workspace_id,
        sim_id: link.sim_id,
        actor_id: user.id,
        actor_role: 'SUB_AGENT',
        action: 'SIM_RECEIPT_ACKNOWLEDGED',
        payload: { assignment_id, notes },
        device_timestamp: new Date().toISOString(),
        source: 'APP',
      }));

      try {
        await admin.from('events').insert(eventRows);
      } catch (evtErr) {
        console.error('Event insert error (non-fatal):', evtErr);
      }
    }

    return successResponse({
      assignment_id,
      status: 'ACKNOWLEDGED',
      quantity: assignment.quantity,
      message: `${assignment.quantity} SIM(s) acknowledged.`,
    });
  } catch (err) {
    console.error('assignments-acknowledge error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});