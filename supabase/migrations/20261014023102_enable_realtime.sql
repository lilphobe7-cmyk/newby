-- ============================================================================
-- SimFlow — Enable Supabase Realtime on key tables
-- ============================================================================

-- Enable replication for the tables we want to broadcast
ALTER PUBLICATION supabase_realtime ADD TABLE public.sims;
ALTER PUBLICATION supabase_realtime ADD TABLE public.registrations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.batches;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- Ensure full row data is sent on updates (default is only changed columns)
ALTER TABLE public.sims REPLICA IDENTITY FULL;
ALTER TABLE public.registrations REPLICA IDENTITY FULL;
ALTER TABLE public.assignments REPLICA IDENTITY FULL;
ALTER TABLE public.batches REPLICA IDENTITY FULL;

-- ============================================================================
-- END
-- ============================================================================