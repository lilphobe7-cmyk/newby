import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');
    }

    const jwt = authHeader.slice(7);

    // We don't validate the JWT here — Realtime will do that.
    // We just echo the token back with a short-lived hint for the client.

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

    return successResponse({
      realtime_url: `${supabaseUrl}/realtime/v1`,
      token: jwt,
      message: 'Use this token to authenticate Supabase Realtime. Call supabase.realtime.setAuth(token) before subscribing.',
    });
  } catch (err) {
    console.error('realtime-auth error:', err);
    return errorResponse(
      'Internal server error: ' + (err instanceof Error ? err.message : String(err)),
      500,
      'INTERNAL'
    );
  }
});