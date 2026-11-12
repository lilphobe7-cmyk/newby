import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient, adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { requireFields } from '../_shared/validate.ts';

/**
 * Changes the global monthly subscription fee.
 *
 * Access: only users whose ID is listed in the ADMIN_USER_IDS environment variable.
 * Set it with: supabase secrets set ADMIN_USER_IDS=uuid1,uuid2
 *
 * The change applies to NEW workspaces immediately. Existing workspaces keep
 * their current fee until their next renewal, at which point you can choose
 * to apply the new price (see the /renew endpoint — future work).
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'METHOD_NOT_ALLOWED');

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const userSb = userClient(authHeader);
    const { data: { user } } = await userSb.auth.getUser();
    if (!user) return errorResponse('Invalid session', 401, 'UNAUTHORIZED');

    // Check admin allowlist
    const adminIds = (Deno.env.get('ADMIN_USER_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (adminIds.length === 0) {
      return errorResponse('No admins configured. Set ADMIN_USER_IDS.', 500, 'NO_ADMINS');
    }
    if (!adminIds.includes(user.id)) {
      return errorResponse('You are not an administrator', 403, 'FORBIDDEN');
    }

    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (!raw || raw.trim() === '') return errorResponse('Empty body', 400, 'EMPTY_BODY');
      body = JSON.parse(raw);
    } catch {
      return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
    }

    const missing = requireFields(body, ['fee_kes']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const feeKes = Number(body.fee_kes);
    if (!Number.isFinite(feeKes) || feeKes < 0 || feeKes > 1000000) {
      return errorResponse('fee_kes must be a number between 0 and 1,000,000', 400, 'INVALID_FEE');
    }

    const admin = adminClient();

    // Read old value for audit
    const { data: oldSetting } = await admin
      .from('app_settings')
      .select('value')
      .eq('key', 'subscription_monthly_fee_kes')
      .maybeSingle();

    // Update
    const { error: updErr } = await admin
      .from('app_settings')
      .upsert({
        key: 'subscription_monthly_fee_kes',
        value: { amount: feeKes },
        description: 'Flat monthly fee in KES for every main agent workspace',
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    if (updErr) {
      console.error('Update failed:', updErr);
      return errorResponse('Failed to update fee: ' + updErr.message, 500, 'DB_ERROR');
    }

    // Audit log
    try {
      await admin.from('admin_audit_log').insert({
        actor_type: 'USER',
        actor_id: user.id,
        action: 'SET_FEE',
        target: 'global',
        payload: { old: oldSetting?.value ?? null, new: { amount: feeKes } },
      });
    } catch (auditErr) {
      console.error('Audit insert failed (non-fatal):', auditErr);
    }

    return successResponse({
      fee_kes: feeKes,
      previous_fee_kes: oldSetting?.value?.amount ?? null,
      applies_to: 'new workspaces only (existing keep their locked-in fee until renewal)',
      message: `Monthly fee is now ${feeKes} KES.`,
    });
  } catch (err) {
    console.error('admin-set-fee error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});