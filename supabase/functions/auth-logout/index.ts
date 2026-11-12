import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { userClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return errorResponse('Missing Authorization header', 401, 'UNAUTHORIZED');

    const supabase = userClient(authHeader);
    await supabase.auth.signOut();

    return successResponse({ message: 'Logged out' });
  } catch (err) {
    console.error('logout error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});