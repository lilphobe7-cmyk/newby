import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { isValidEmail, requireFields } from '../_shared/validate.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const missing = requireFields(body, ['email']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');
    if (!isValidEmail(body.email)) return errorResponse('Invalid email', 400, 'INVALID_EMAIL');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    );

    // Supabase will silently succeed even if email doesn't exist
    await supabase.auth.resetPasswordForEmail(body.email, {
      redirectTo: body.redirect_to ?? 'simflow://reset-password',
    });

    // Always return success to prevent email enumeration
    return successResponse({
      message: 'If this email exists, a password reset link has been sent.',
    });
  } catch (err) {
    console.error('forgot-password error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});