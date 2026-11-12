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
    const batchId = url.searchParams.get('batch_id');
    if (!batchId) return errorResponse('Missing batch_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    const { data: batch, error } = await admin
      .from('batches')
      .select(`
        id, workspace_id, reference, supplier, date_received,
        quantity_expected, quantity_scanned,
        status, notes, created_by, created_at,
        updated_at, closed_at, archived_at,
        network_id,
        network:networks (id, code, display_name)
      `)
      .eq('id', batchId)
      .maybeSingle();

    if (error) {
      console.error('batch fetch error:', error);
      return errorResponse('Query failed', 500, 'DB_ERROR');
    }
    if (!batch) return errorResponse('Batch not found', 404, 'NOT_FOUND');

    // Verify membership
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', batch.workspace_id)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');

    // Count SIMs by status
    const { data: simStatuses } = await admin
      .from('sims')
      .select('status')
      .eq('batch_id', batchId)
      .is('deleted_at', null);

    const statusCounts: Record<string, number> = {};
    for (const s of simStatuses ?? []) {
      statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    }

    return successResponse({
      batch: {
        ...batch,
        quantity_unaccounted: Math.max(0, (batch.quantity_expected ?? 0) - (batch.quantity_scanned ?? 0)),
        status_counts: statusCounts,
      },
    });
  } catch (err) {
    console.error('batches-detail error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});