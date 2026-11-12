import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { adminClient } from '../_shared/supabase.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, successResponse } from '../_shared/errors.ts';
import { isValidEmail, isStrongPassword, requireFields } from '../_shared/validate.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    const missing = requireFields(body, ['email', 'password', 'full_name', 'workspace_name']);
    if (missing) return errorResponse(missing, 400, 'MISSING_FIELD');

    const { email, password, full_name, workspace_name, business_name, phone } = body;

    if (!isValidEmail(email)) return errorResponse('Invalid email format', 400, 'INVALID_EMAIL');
    if (!isStrongPassword(password)) {
      return errorResponse(
        'Password must be at least 8 characters and contain a letter and a number',
        400,
        'WEAK_PASSWORD'
      );
    }

    const supabase = adminClient();

    // Read the dev auto-confirm flag from environment
    // Set via: supabase secrets set AUTH_AUTO_CONFIRM=true
    // Unset before production: supabase secrets unset AUTH_AUTO_CONFIRM
    const autoConfirm = Deno.env.get('AUTH_AUTO_CONFIRM') === 'true';

    // 1. Create the auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: autoConfirm,
      user_metadata: { full_name },
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        return errorResponse('This email is already registered', 409, 'EMAIL_TAKEN');
      }
      return errorResponse(authError.message, 400, 'AUTH_ERROR');
    }

    const userId = authData.user.id;

    // 2. Create the workspace
    const { data: workspace, error: wsError } = await supabase
      .from('workspaces')
      .insert({
        owner_user_id: userId,
        name: workspace_name,
        business_name: business_name ?? null,
        phone: phone ?? null,
      })
      .select('id')
      .single();

    if (wsError) {
      // Roll back the user
      await supabase.auth.admin.deleteUser(userId);
      return errorResponse('Failed to create workspace: ' + wsError.message, 500, 'WORKSPACE_ERROR');
    }

    // 3. Add the main agent as a workspace member
    const { error: wmError } = await supabase
      .from('workspace_members')
      .insert({
        workspace_id: workspace.id,
        user_id: userId,
        role: 'MAIN_AGENT',
        display_name: full_name,
      });

    if (wmError) {
      await supabase.auth.admin.deleteUser(userId);
      await supabase.from('workspaces').delete().eq('id', workspace.id);
      return errorResponse('Failed to link workspace: ' + wmError.message, 500, 'MEMBER_ERROR');
    }

    // 4. If auto-confirming, record that we did so (helps with audits)
    if (autoConfirm) {
      await supabase.from('events').insert({
        event_id: crypto.randomUUID(),
        workspace_id: workspace.id,
        actor_id: userId,
        actor_role: 'MAIN_AGENT',
        action: 'USER_JOINED_WORKSPACE',
        payload: { email, full_name, auto_confirmed: true },
        device_timestamp: new Date().toISOString(),
        source: 'SYSTEM',
      });
    }

    return successResponse({
      user_id: userId,
      workspace_id: workspace.id,
      email,
      auto_confirmed: autoConfirm,
      message: autoConfirm
        ? 'Account created. You can sign in now.'
        : 'Account created. Please check your email to confirm.',
    }, 201);
  } catch (err) {
    console.error('main-agent-signup error:', err);
    return errorResponse('Internal server error', 500, 'INTERNAL');
  }
});