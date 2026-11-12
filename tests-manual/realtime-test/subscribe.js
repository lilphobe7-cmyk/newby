// Real-time subscription test
// Run with: node subscribe.js <email> <password> <workspace_id>

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://qhqzbibkrvvgnqirgmvo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFocXpiaWJrcnZ2Z25xaXJnbXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTg2MzYsImV4cCI6MjEwNzM3NDYzNn0.p7Ayft2ypLgngWwT78yVLmnoOL0AjcQEl8T_ClxWNoU'; // paste your anon key

const [, , email, password, workspaceId] = process.argv;

if (!email || !password || !workspaceId) {
  console.error('Usage: node subscribe.js <email> <password> <workspace_id>');
  process.exit(1);
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  console.log(`Signing in as ${email}...`);
  const { data: { session }, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError || !session) {
    console.error('Login failed:', authError?.message);
    process.exit(1);
  }

  console.log('Logged in. Setting Realtime auth...');
  await supabase.realtime.setAuth(session.access_token);

  console.log(`Subscribing to changes on workspace ${workspaceId}...\n`);

  const channel = supabase
    .channel(`workspace-${workspaceId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'sims',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      (payload) => {
        console.log('--- SIMS CHANGE ---');
        console.log('Event:', payload.eventType);
        console.log('Record:', JSON.stringify(payload.new, null, 2));
        console.log('');
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'registrations',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      (payload) => {
        console.log('--- NEW REGISTRATION ---');
        console.log('Record:', JSON.stringify(payload.new, null, 2));
        console.log('');
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'events',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      (payload) => {
        console.log('--- NEW EVENT ---');
        console.log('Action:', payload.new.action);
        console.log('Actor:', payload.new.actor_id);
        console.log('');
      }
    )
    .subscribe((status) => {
      console.log('Subscription status:', status);
    });

  // Keep alive
  process.on('SIGINT', async () => {
    console.log('\nUnsubscribing...');
    await supabase.removeChannel(channel);
    process.exit(0);
  });
}

main().catch(console.error);