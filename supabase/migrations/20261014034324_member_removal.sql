-- ============================================================================
-- SimFlow -- Sub-agent removal tracking
-- ============================================================================

ALTER TABLE public.workspace_members
  ADD COLUMN IF NOT EXISTS removed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_wm_active
  ON public.workspace_members(workspace_id, role)
  WHERE removed_at IS NULL;

-- ============================================================================
-- END
-- ============================================================================