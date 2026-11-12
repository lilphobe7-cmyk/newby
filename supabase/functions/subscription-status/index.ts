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
    const workspaceId = url.searchParams.get('workspace_id');
    if (!workspaceId) return errorResponse('Missing workspace_id', 400, 'MISSING_FIELD');

    const admin = adminClient();

    // Only main agent can see subscription details
    const { data: member } = await admin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .is('removed_at', null)
      .maybeSingle();

    if (!member) return errorResponse('Forbidden', 403, 'FORBIDDEN');
    if (member.role !== 'MAIN_AGENT') {
      return errorResponse('Only the main agent can view subscription details', 403, 'FORBIDDEN');
    }

    const { data: subscription, error } = await admin
      .from('workspace_subscriptions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) {
      console.error('subscription fetch error:', error);
      return errorResponse('Query failed', 500, 'DB_ERROR');
    }

    // Read the current global fee from app_settings
    const { data: feeSetting } = await admin
      .from('app_settings')
      .select('value')
      .eq('key', 'subscription_monthly_fee_kes')
      .maybeSingle();

    const currentGlobalFee = (feeSetting?.value as { amount?: number })?.amount ?? null;

    // Recent payments
    const { data: payments } = await admin
      .from('payments')
      .select('id, amount_kes, method, reference, status, recorded_at, confirmed_at, period_start, period_end')
      .eq('workspace_id', workspaceId)
      .order('recorded_at', { ascending: false })
      .limit(10);

    return successResponse({
      subscription,
      current_global_fee_kes: currentGlobalFee,
      recent_payments: payments ?? [],
    });
  } catch (err) {
    console.error('subscription-status error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});