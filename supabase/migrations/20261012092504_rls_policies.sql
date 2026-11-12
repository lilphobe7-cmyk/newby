-- ============================================================================
-- SimFlow — Row-Level Security Policies
-- ============================================================================
-- Enables RLS on every business table and defines who can see what.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- HELPER FUNCTIONS
-- ----------------------------------------------------------------------------

-- Returns TRUE if the given user is a member of the given workspace
CREATE OR REPLACE FUNCTION public.is_workspace_member(
  check_workspace_id UUID,
  check_user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = check_workspace_id
      AND user_id = check_user_id
      AND removed_at IS NULL
  );
$$;

-- Returns TRUE if the given user is the MAIN_AGENT of the workspace
CREATE OR REPLACE FUNCTION public.is_main_agent(
  check_workspace_id UUID,
  check_user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = check_workspace_id
      AND user_id = check_user_id
      AND role = 'MAIN_AGENT'
      AND removed_at IS NULL
  );
$$;

-- Returns TRUE if the user is a SUB_AGENT in the given workspace
CREATE OR REPLACE FUNCTION public.is_sub_agent(
  check_workspace_id UUID,
  check_user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = check_workspace_id
      AND user_id = check_user_id
      AND role = 'SUB_AGENT'
      AND removed_at IS NULL
  );
$$;

-- Returns the workspace IDs the user belongs to
CREATE OR REPLACE FUNCTION public.my_workspace_ids(
  check_user_id UUID DEFAULT auth.uid()
)
RETURNS UUID[]
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(ARRAY_AGG(workspace_id), '{}')
  FROM public.workspace_members
  WHERE user_id = check_user_id AND removed_at IS NULL;
$$;

-- ----------------------------------------------------------------------------
-- ENABLE RLS ON EVERY TABLE
-- ----------------------------------------------------------------------------
ALTER TABLE public.networks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sims               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conflicts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tombstones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_receipts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications      ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- POLICIES
-- ============================================================================

-- ----------------------------------------------------------------------------
-- NETWORKS — read-only for all authenticated users
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS networks_read_all ON public.networks;
CREATE POLICY networks_read_all
  ON public.networks FOR SELECT
  TO authenticated
  USING (is_active = TRUE);

-- ----------------------------------------------------------------------------
-- WORKSPACES
-- Members can read their workspace. Owner (main agent) can update.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS workspaces_read ON public.workspaces;
CREATE POLICY workspaces_read
  ON public.workspaces FOR SELECT
  TO authenticated
  USING (id = ANY(my_workspace_ids()));

DROP POLICY IF EXISTS workspaces_insert ON public.workspaces;
CREATE POLICY workspaces_insert
  ON public.workspaces FOR INSERT
  TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS workspaces_update ON public.workspaces;
CREATE POLICY workspaces_update
  ON public.workspaces FOR UPDATE
  TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- WORKSPACE_MEMBERS
-- Members see other members of their workspace. Only main agent can add/remove.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS wm_read ON public.workspace_members;
CREATE POLICY wm_read
  ON public.workspace_members FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(my_workspace_ids()));

DROP POLICY IF EXISTS wm_insert ON public.workspace_members;
CREATE POLICY wm_insert
  ON public.workspace_members FOR INSERT
  TO authenticated
  WITH CHECK (
    is_main_agent(workspace_id, auth.uid())
    OR user_id = auth.uid()  -- self-join via invitation
  );

DROP POLICY IF EXISTS wm_update ON public.workspace_members;
CREATE POLICY wm_update
  ON public.workspace_members FOR UPDATE
  TO authenticated
  USING (is_main_agent(workspace_id, auth.uid()))
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

-- ----------------------------------------------------------------------------
-- USER_ROLES — users see only their own row
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS user_roles_self ON public.user_roles;
CREATE POLICY user_roles_self
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- INVITATIONS
-- Main agent sees and manages invitations for their workspace.
-- Anonymous users need to read a single invitation by token_hash to sign up.
-- (The Edge Function uses service_role for lookup — no anon policy needed.)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS invitations_read ON public.invitations;
CREATE POLICY invitations_read
  ON public.invitations FOR SELECT
  TO authenticated
  USING (is_main_agent(workspace_id, auth.uid()));

DROP POLICY IF EXISTS invitations_insert ON public.invitations;
CREATE POLICY invitations_insert
  ON public.invitations FOR INSERT
  TO authenticated
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

DROP POLICY IF EXISTS invitations_update ON public.invitations;
CREATE POLICY invitations_update
  ON public.invitations FOR UPDATE
  TO authenticated
  USING (is_main_agent(workspace_id, auth.uid()))
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

-- ----------------------------------------------------------------------------
-- BATCHES
-- Main agent: full access to their workspace.
-- Sub-agent: read-only, and only batches containing SIMs they hold.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS batches_read ON public.batches;
CREATE POLICY batches_read
  ON public.batches FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS batches_write ON public.batches;
CREATE POLICY batches_write
  ON public.batches FOR INSERT
  TO authenticated
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

DROP POLICY IF EXISTS batches_update ON public.batches;
CREATE POLICY batches_update
  ON public.batches FOR UPDATE
  TO authenticated
  USING (is_main_agent(workspace_id, auth.uid()))
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

-- ----------------------------------------------------------------------------
-- SIMS — the heart of access control
-- Main agent: sees all SIMs in workspace.
-- Sub-agent: sees only SIMs where holder_user_id = auth.uid().
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS sims_read ON public.sims;
CREATE POLICY sims_read
  ON public.sims FOR SELECT
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR holder_user_id = auth.uid()
  );

DROP POLICY IF EXISTS sims_insert ON public.sims;
CREATE POLICY sims_insert
  ON public.sims FOR INSERT
  TO authenticated
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

DROP POLICY IF EXISTS sims_update ON public.sims;
CREATE POLICY sims_update
  ON public.sims FOR UPDATE
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR holder_user_id = auth.uid()
  )
  WITH CHECK (
    is_main_agent(workspace_id, auth.uid())
    OR holder_user_id = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- EVENTS — append-only log
-- Main agent: reads all events in workspace.
-- Sub-agent: reads only events they authored, or events on SIMs they hold.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read
  ON public.events FOR SELECT
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR actor_id = auth.uid()
    OR sim_id IN (SELECT id FROM public.sims WHERE holder_user_id = auth.uid())
  );

DROP POLICY IF EXISTS events_insert ON public.events;
CREATE POLICY events_insert
  ON public.events FOR INSERT
  TO authenticated
  WITH CHECK (
    is_workspace_member(workspace_id, auth.uid())
    AND actor_id = auth.uid()
  );

-- No UPDATE or DELETE policy — events are immutable.

-- ----------------------------------------------------------------------------
-- ASSIGNMENTS
-- Main agent: full read/write in workspace.
-- Sub-agent: read only assignments where they are assigned_to.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS assignments_read ON public.assignments;
CREATE POLICY assignments_read
  ON public.assignments FOR SELECT
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR assigned_to = auth.uid()
    OR assigned_by = auth.uid()
  );

DROP POLICY IF EXISTS assignments_insert ON public.assignments;
CREATE POLICY assignments_insert
  ON public.assignments FOR INSERT
  TO authenticated
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

DROP POLICY IF EXISTS assignments_update ON public.assignments;
CREATE POLICY assignments_update
  ON public.assignments FOR UPDATE
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR assigned_to = auth.uid()
  )
  WITH CHECK (
    is_main_agent(workspace_id, auth.uid())
    OR assigned_to = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- REGISTRATIONS
-- Main agent: full read in workspace.
-- Sub-agent: read own reports; insert own reports.
-- Verification is main-agent only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS registrations_read ON public.registrations;
CREATE POLICY registrations_read
  ON public.registrations FOR SELECT
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR reported_by = auth.uid()
  );

DROP POLICY IF EXISTS registrations_insert ON public.registrations;
CREATE POLICY registrations_insert
  ON public.registrations FOR INSERT
  TO authenticated
  WITH CHECK (
    is_workspace_member(workspace_id, auth.uid())
    AND reported_by = auth.uid()
  );

DROP POLICY IF EXISTS registrations_update ON public.registrations;
CREATE POLICY registrations_update
  ON public.registrations FOR UPDATE
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR reported_by = auth.uid()
  )
  WITH CHECK (
    is_main_agent(workspace_id, auth.uid())
    OR reported_by = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- CONFLICTS
-- Main agent: read + resolve.
-- Sub-agent: read only conflicts on SIMs they hold.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS conflicts_read ON public.conflicts;
CREATE POLICY conflicts_read
  ON public.conflicts FOR SELECT
  TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR sim_id IN (SELECT id FROM public.sims WHERE holder_user_id = auth.uid())
  );

DROP POLICY IF EXISTS conflicts_write ON public.conflicts;
CREATE POLICY conflicts_write
  ON public.conflicts FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS conflicts_update ON public.conflicts;
CREATE POLICY conflicts_update
  ON public.conflicts FOR UPDATE
  TO authenticated
  USING (is_main_agent(workspace_id, auth.uid()))
  WITH CHECK (is_main_agent(workspace_id, auth.uid()));

-- ----------------------------------------------------------------------------
-- TOMBSTONES
-- Main agent reads tombstones for their workspace. Anyone can insert their own.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS tombstones_read ON public.tombstones;
CREATE POLICY tombstones_read
  ON public.tombstones FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(my_workspace_ids())
    OR removed_by = auth.uid()
  );

DROP POLICY IF EXISTS tombstones_insert ON public.tombstones;
CREATE POLICY tombstones_insert
  ON public.tombstones FOR INSERT
  TO authenticated
  WITH CHECK (removed_by = auth.uid());

-- ----------------------------------------------------------------------------
-- SYNC_RECEIPTS — users see only their own
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS sync_receipts_self ON public.sync_receipts;
CREATE POLICY sync_receipts_self
  ON public.sync_receipts FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS sync_receipts_insert ON public.sync_receipts;
CREATE POLICY sync_receipts_insert
  ON public.sync_receipts FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS — users see only their own
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS notifications_self ON public.notifications;
CREATE POLICY notifications_self
  ON public.notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_update_self ON public.notifications;
CREATE POLICY notifications_update_self
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- END OF RLS POLICIES
-- ============================================================================