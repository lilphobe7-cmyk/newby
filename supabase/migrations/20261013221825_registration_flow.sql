-- ============================================================================
-- SimFlow — Registration flow additions
-- ============================================================================

-- Track when a registration can still be corrected by the sub-agent
ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS correction_expires_at TIMESTAMPTZ;

-- Track offline sync batches (useful for debugging and deduplication)
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS ingest_batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_events_ingest_batch
  ON public.events(ingest_batch_id) WHERE ingest_batch_id IS NOT NULL;

-- Index for correction window lookups
CREATE INDEX IF NOT EXISTS idx_registrations_correction
  ON public.registrations(correction_expires_at) WHERE correction_expires_at IS NOT NULL;

-- Trigger: set correction_expires_at when a registration is inserted
CREATE OR REPLACE FUNCTION public.set_registration_correction_window()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.correction_expires_at IS NULL THEN
    NEW.correction_expires_at := NEW.reported_at + INTERVAL '15 minutes';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_registration_correction_window ON public.registrations;
CREATE TRIGGER trg_registration_correction_window
  BEFORE INSERT ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_registration_correction_window();

-- ============================================================================
-- END
-- ============================================================================