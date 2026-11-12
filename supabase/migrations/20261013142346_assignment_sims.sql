-- ============================================================================
-- SimFlow — assignment_sims join table
-- ============================================================================
-- Allows an assignment to contain multiple SIMs (one-to-many).
-- ============================================================================

-- Make the existing sim_id column nullable (it will be deprecated)
ALTER TABLE public.assignments ALTER COLUMN sim_id DROP NOT NULL;

-- New join table
CREATE TABLE IF NOT EXISTS public.assignment_sims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   UUID NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  sim_id          UUID NOT NULL REFERENCES public.sims(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assignment_id, sim_id)
);

CREATE INDEX IF NOT EXISTS idx_assignment_sims_assignment ON public.assignment_sims(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_sims_sim ON public.assignment_sims(sim_id);

-- Enable RLS
ALTER TABLE public.assignment_sims ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS assignment_sims_read ON public.assignment_sims;
CREATE POLICY assignment_sims_read
  ON public.assignment_sims FOR SELECT
  TO authenticated
  USING (
    assignment_id IN (
      SELECT id FROM public.assignments
      WHERE is_main_agent(workspace_id, auth.uid())
        OR assigned_to = auth.uid()
        OR assigned_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS assignment_sims_insert ON public.assignment_sims;
CREATE POLICY assignment_sims_insert
  ON public.assignment_sims FOR INSERT
  TO authenticated
  WITH CHECK (
    assignment_id IN (
      SELECT id FROM public.assignments
      WHERE is_main_agent(workspace_id, auth.uid())
    )
  );

-- ============================================================================
-- END
-- ============================================================================