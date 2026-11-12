import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { isStrongPassword, requireFields } from '../_shared/validate.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const missing = requireFields(body, ['access_token', 'new_password']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    if (!isStrongPassword(body.new_password)) {
      return errorResponse('Password too weak', 400, 'WEAK_PASSWORD');
    }

    // The recovery flow gives a temporary access_token. We use it to update the password.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${body.access_token}` } } }
    );

    const { error } = await supabase.auth.updateUser({
      password: body.new_password,
    });

    if (error) return errorResponse(error.message, 400, 'RESET_FAILED');

    return successResponse({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('reset-password error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});