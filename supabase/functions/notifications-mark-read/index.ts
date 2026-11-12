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

    const markAll = body.all === true;
    const notificationId = body.notification_id ? String(body.notification_id).trim() : null;

    if (!markAll && !notificationId) {
      return errorResponse('Provide notification_id or set all=true', 400, 'MISSING_FIELD');
    }

    const admin = adminClient();
    const now = new Date().toISOString();

    if (markAll) {
      const { data: updated, error } = await admin
        .from('notifications')
        .update({ read_at: now })
        .eq('user_id', user.id)
        .is('read_at', null)
        .select('id');

      if (error) {
        console.error('Mark-all error:', error);
        return errorResponse('Failed: ' + error.message, 500, 'DB_ERROR');
      }

      return successResponse({
        marked: updated?.length ?? 0,
        message: `${updated?.length ?? 0} notification(s) marked as read.`,
      });
    }

    // Single notification
    const { data: existing } = await admin
      .from('notifications')
      .select('id, user_id, read_at')
      .eq('id', notificationId!)
      .maybeSingle();

    if (!existing) return errorResponse('Notification not found', 404, 'NOT_FOUND');
    if (existing.user_id !== user.id) {
      return errorResponse('Not your notification', 403, 'FORBIDDEN');
    }
    if (existing.read_at) {
      return successResponse({ marked: 0, already_read: true, message: 'Already read.' });
    }

    const { error: updErr } = await admin
      .from('notifications')
      .update({ read_at: now })
      .eq('id', notificationId!);

    if (updErr) {
      console.error('Mark-one error:', updErr);
      return errorResponse('Failed: ' + updErr.message, 500, 'DB_ERROR');
    }

    return successResponse({ marked: 1, message: 'Marked as read.' });
  } catch (err) {
    console.error('notifications-mark-read error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});