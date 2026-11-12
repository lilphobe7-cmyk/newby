-- ============================================================================
-- SimFlow — Auto-update batch quantity_scanned
-- ============================================================================
-- Whenever a SIM is inserted, deleted or its batch_id changes,
-- recount the affected batches' quantity_scanned.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_batch_scanned_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_batch_ids UUID[];
BEGIN
  -- Collect affected batch IDs (old and new)
  IF TG_OP = 'INSERT' THEN
    affected_batch_ids := ARRAY[NEW.batch_id];
  ELSIF TG_OP = 'DELETE' THEN
    affected_batch_ids := ARRAY[OLD.batch_id];
  ELSIF TG_OP = 'UPDATE' THEN
    affected_batch_ids := ARRAY[OLD.batch_id, NEW.batch_id];
  END IF;

  -- Update counters (ignore NULL batch IDs)
  UPDATE public.batches b
  SET quantity_scanned = (
    SELECT COUNT(*) FROM public.sims s WHERE s.batch_id = b.id
  )
  WHERE b.id = ANY(affected_batch_ids)
    AND b.id IS NOT NULL;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attach the trigger to the sims table
DROP TRIGGER IF EXISTS trg_update_batch_scanned_count ON public.sims;

CREATE TRIGGER trg_update_batch_scanned_count
  AFTER INSERT OR UPDATE OF batch_id OR DELETE ON public.sims
  FOR EACH ROW
  EXECUTE FUNCTION public.update_batch_scanned_count();

-- ============================================================================
-- END
-- ============================================================================