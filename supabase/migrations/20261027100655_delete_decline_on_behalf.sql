-- ============================================================================
-- SimFlow — Support for delete, decline, and acting on behalf
-- ============================================================================

-- 1. Audit: who did this, and on whose behalf?
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS acted_on_behalf_of UUID 
  REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Track when a registration was declined (accidental tap reversal)
ALTER TABLE public.registrations
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- 3. Extend sync_receipts so that "declined registration" flows work offline too
-- (no change needed — existing schema handles any event)

-- 4. Index for fast "who reported what" lookups
CREATE INDEX IF NOT EXISTS idx_events_acted_on_behalf
  ON public.events(acted_on_behalf_of)
  WHERE acted_on_behalf_of IS NOT NULL;

-- 5. Index for querying declined registrations
CREATE INDEX IF NOT EXISTS idx_registrations_declined
  ON public.registrations(declined_at)
  WHERE declined_at IS NOT NULL;

-- ============================================================================
-- END
-- ============================================================================