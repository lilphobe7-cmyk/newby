-- ============================================================================
-- SimFlow — Initial Schema
-- ============================================================================
-- This migration creates all core tables for the SimFlow system.
-- It is idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- EXTENSIONS
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------

-- User roles within a workspace
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('MAIN_AGENT', 'SUB_AGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SIM lifecycle status
DO $$ BEGIN
  CREATE TYPE sim_status AS ENUM (
    'AWAITING_ASSIGNMENT',
    'ASSIGNED',
    'NOT_YET_REGISTERED',
    'REGISTRATION_ATTEMPTED',
    'REPORTED_REGISTERED',
    'VERIFICATION_PENDING',
    'VERIFIED_REGISTERED',
    'REGISTRATION_FAILED',
    'RETURNED',
    'DAMAGED',
    'MISSING',
    'DEACTIVATED',
    'EXPIRED_IN_STOCK',
    'EXPIRED_ASSIGNED',
    'EXPIRED_REGISTERED',
    'EXPIRED_VERIFIED',
    'ARCHIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Event actions (append-only log)
DO $$ BEGIN
  CREATE TYPE event_action AS ENUM (
    'BATCH_CREATED',
    'SIM_ADDED',
    'SIM_SCANNED',
    'SIM_ASSIGNED',
    'SIM_RECEIPT_ACKNOWLEDGED',
    'SIM_RETURNED',
    'SIM_TRANSFERRED',
    'REGISTRATION_REPORTED',
    'REGISTRATION_VERIFIED',
    'REGISTRATION_REJECTED',
    'REGISTRATION_CORRECTED',
    'SIM_DAMAGED',
    'SIM_MISSING',
    'SIM_DEACTIVATED',
    'SIM_EXPIRED',
    'SIM_ARCHIVED',
    'SIM_SOFT_DELETED',
    'SIM_RESTORED',
    'SIM_HARD_DELETED',
    'CONFLICT_FLAGGED',
    'CONFLICT_RESOLVED',
    'INVITATION_CREATED',
    'INVITATION_USED',
    'INVITATION_REVOKED',
    'USER_JOINED_WORKSPACE',
    'USER_REMOVED_FROM_WORKSPACE',
    'CORRECTION_REQUESTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Invitation status
DO $$ BEGIN
  CREATE TYPE invitation_status AS ENUM ('PENDING', 'USED', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Registration outcome
DO $$ BEGIN
  CREATE TYPE registration_outcome AS ENUM (
    'REGISTERED',
    'FAILED_REJECTED',
    'FAILED_CUSTOMER_INCOMPLETE',
    'FAILED_SIM_UNREADABLE',
    'FAILED_SYSTEM_UNAVAILABLE',
    'FAILED_OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Verification source
DO $$ BEGIN
  CREATE TYPE verification_source AS ENUM (
    'OPERATOR_API',
    'OPERATOR_REPORT',
    'MANUAL_MAIN_AGENT',
    'NONE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Conflict status
DO $$ BEGIN
  CREATE TYPE conflict_status AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tombstone reasons
DO $$ BEGIN
  CREATE TYPE tombstone_reason AS ENUM (
    'MISTAKEN_ENTRY',
    'DUPLICATE_SCAN',
    'LEGAL_REQUEST',
    'WORKSPACE_WIPE',
    'DATA_PROTECTION',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- NETWORKS (Airtel, Safaricom, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.networks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,          -- 'AIRTEL', 'SAFARICOM'
  display_name    TEXT NOT NULL,                 -- 'Airtel Kenya'
  country_code    TEXT NOT NULL DEFAULT 'KE',
  msisdn_prefixes TEXT[] NOT NULL DEFAULT '{}',  -- ['+25473', '+25478']
  iccid_prefixes  TEXT[] NOT NULL DEFAULT '{}',  -- ['89254']
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- WORKSPACES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspaces (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  business_name     TEXT,
  phone             TEXT,
  country_code      TEXT NOT NULL DEFAULT 'KE',
  settings          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON public.workspaces(owner_user_id);

-- ----------------------------------------------------------------------------
-- WORKSPACE MEMBERS (who belongs to which workspace, with what role)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            user_role NOT NULL,
  display_name    TEXT,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at      TIMESTAMPTZ,
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_workspace ON public.workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_wm_user ON public.workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_wm_role ON public.workspace_members(workspace_id, role);

-- ----------------------------------------------------------------------------
-- USER ROLES (for RLS policy checks)
-- ----------------------------------------------------------------------------
-- This is a denormalized table for fast RLS policy evaluation.
-- It mirrors workspace_members but with role as a text array per user.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  roles           TEXT[] NOT NULL DEFAULT '{}',
  workspace_ids   UUID[] NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- INVITATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  token_hash        TEXT NOT NULL UNIQUE,        -- sha256 of the token sent in the link
  status            invitation_status NOT NULL DEFAULT 'PENDING',
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  used_by_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON public.invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON public.invitations(status);
CREATE INDEX IF NOT EXISTS idx_invitations_token_hash ON public.invitations(token_hash);

-- ----------------------------------------------------------------------------
-- BATCHES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  network_id        UUID NOT NULL REFERENCES public.networks(id) ON DELETE RESTRICT,
  reference         TEXT NOT NULL,
  supplier          TEXT,
  date_received     DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity_expected INTEGER NOT NULL DEFAULT 0 CHECK (quantity_expected >= 0),
  quantity_scanned  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_scanned >= 0),
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, CLOSED, DISCREPANCY
  created_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  UNIQUE (workspace_id, reference)
);

CREATE INDEX IF NOT EXISTS idx_batches_workspace ON public.batches(workspace_id);
CREATE INDEX IF NOT EXISTS idx_batches_network ON public.batches(network_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON public.batches(workspace_id, status);

-- ----------------------------------------------------------------------------
-- SIMS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  batch_id          UUID REFERENCES public.batches(id) ON DELETE SET NULL,
  network_id        UUID NOT NULL REFERENCES public.networks(id) ON DELETE RESTRICT,

  -- Identifiers
  iccid             TEXT NOT NULL,                          -- ICCID (serial number)
  msisdn            TEXT,                                   -- phone number, E.164
  imsi              TEXT,

  -- Dates
  expiry_date       DATE,
  activated_at      TIMESTAMPTZ,
  deactivated_at    TIMESTAMPTZ,

  -- Current holder
  holder_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  holder_type       TEXT,                                   -- 'MAIN_AGENT' | 'SUB_AGENT' | null

  -- Status
  status            sim_status NOT NULL DEFAULT 'AWAITING_ASSIGNMENT',

  -- Verification (operator data)
  registration_verified_at    TIMESTAMPTZ,
  registration_verified_by    verification_source,
  activation_verified_at      TIMESTAMPTZ,
  activation_verified_by      verification_source,

  -- Scan metadata
  scan_confidence   JSONB,                                  -- {iccid, msisdn, expiry}
  scan_method       TEXT,                                   -- 'CAMERA_AUTO' | 'CAMERA_MANUAL' | 'MANUAL_ENTRY' | 'BULK_IMPORT'
  raw_scan_text     TEXT,

  -- Soft delete / archive
  deleted_at        TIMESTAMPTZ,
  deletion_reason   TEXT,
  recoverable_until TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  expired_at        TIMESTAMPTZ,
  tombstone_id      UUID,

  -- Audit
  created_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, iccid)
);

CREATE INDEX IF NOT EXISTS idx_sims_workspace ON public.sims(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sims_batch ON public.sims(batch_id);
CREATE INDEX IF NOT EXISTS idx_sims_holder ON public.sims(holder_user_id);
CREATE INDEX IF NOT EXISTS idx_sims_status ON public.sims(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_sims_iccid ON public.sims(iccid);
CREATE INDEX IF NOT EXISTS idx_sims_msisdn ON public.sims(msisdn);
CREATE INDEX IF NOT EXISTS idx_sims_expiry ON public.sims(expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sims_deleted ON public.sims(deleted_at) WHERE deleted_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- EVENTS (append-only log — the source of truth)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.events (
  id                BIGSERIAL PRIMARY KEY,
  event_id          UUID NOT NULL UNIQUE,                 -- client-generated UUID for idempotency
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sim_id            UUID REFERENCES public.sims(id) ON DELETE SET NULL,
  batch_id          UUID REFERENCES public.batches(id) ON DELETE SET NULL,
  actor_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role        user_role NOT NULL,

  action            event_action NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,

  device_timestamp  TIMESTAMPTZ NOT NULL,
  server_timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  source            TEXT NOT NULL DEFAULT 'APP',         -- 'APP' | 'SYSTEM' | 'IMPORT'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_workspace_ts ON public.events(workspace_id, server_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_sim ON public.events(sim_id, server_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_actor ON public.events(actor_id, server_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_action ON public.events(action);
CREATE INDEX IF NOT EXISTS idx_events_event_id ON public.events(event_id);

-- ----------------------------------------------------------------------------
-- ASSIGNMENTS (formal handover records)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assignments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sim_id            UUID NOT NULL REFERENCES public.sims(id) ON DELETE CASCADE,
  assigned_by       UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  assigned_to       UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  quantity          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'PENDING_ACK',   -- PENDING_ACK | ACKNOWLEDGED | RETURNED | TRANSFERRED
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at   TIMESTAMPTZ,
  returned_at       TIMESTAMPTZ,
  returned_to       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignments_workspace ON public.assignments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_assignments_sim ON public.assignments(sim_id);
CREATE INDEX IF NOT EXISTS idx_assignments_to ON public.assignments(assigned_to);
CREATE INDEX IF NOT EXISTS idx_assignments_status ON public.assignments(workspace_id, status);

-- ----------------------------------------------------------------------------
-- REGISTRATIONS (sub-agent and main-agent registration reports)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registrations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sim_id                UUID NOT NULL REFERENCES public.sims(id) ON DELETE CASCADE,
  reported_by           UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,

  outcome               registration_outcome NOT NULL,
  phone_number          TEXT,
  registration_date     TIMESTAMPTZ,
  customer_reference    TEXT,
  operator_reference    TEXT,
  notes                 TEXT,
  evidence_url          TEXT,

  -- Verification
  verification_status   TEXT NOT NULL DEFAULT 'UNVERIFIED', -- UNVERIFIED | PENDING | VERIFIED | REJECTED
  verified_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at           TIMESTAMPTZ,
  verification_source   verification_source DEFAULT 'NONE',
  verification_notes    TEXT,

  -- Correction chain
  corrected_by_registration_id UUID REFERENCES public.registrations(id) ON DELETE SET NULL,
  is_correction         BOOLEAN NOT NULL DEFAULT FALSE,

  -- Audit
  reported_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_registrations_workspace ON public.registrations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_registrations_sim ON public.registrations(sim_id);
CREATE INDEX IF NOT EXISTS idx_registrations_reporter ON public.registrations(reported_by);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON public.registrations(verification_status);

-- ----------------------------------------------------------------------------
-- CONFLICTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conflicts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sim_id            UUID NOT NULL REFERENCES public.sims(id) ON DELETE CASCADE,

  conflict_type     TEXT NOT NULL,       -- 'DUPLICATE_REGISTRATION' | 'STATUS_MISMATCH' | 'HOLDER_MISMATCH'
  description       TEXT NOT NULL,
  related_event_ids UUID[] NOT NULL DEFAULT '{}',

  status            conflict_status NOT NULL DEFAULT 'OPEN',
  resolved_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ,
  resolution_notes  TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conflicts_workspace ON public.conflicts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_conflicts_sim ON public.conflicts(sim_id);

-- ----------------------------------------------------------------------------
-- TOMBSTONES (record of every removal)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tombstones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type       TEXT NOT NULL,        -- 'SIM' | 'BATCH' | 'REGISTRATION' | 'INVITATION'
  entity_id         TEXT NOT NULL,
  workspace_id      UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  removed_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  removed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason            tombstone_reason NOT NULL,
  notes             TEXT,
  recoverable       BOOLEAN NOT NULL DEFAULT TRUE,
  recovery_deadline TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_tombstones_workspace ON public.tombstones(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tombstones_entity ON public.tombstones(entity_type, entity_id);

-- ----------------------------------------------------------------------------
-- SYNC RECEIPTS (idempotency for offline sync)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_receipts (
  event_id          UUID PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  server_event_id   BIGINT NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  server_timestamp  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_receipts_user ON public.sync_receipts(user_id, received_at DESC);

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications(user_id) WHERE read_at IS NULL;

-- ----------------------------------------------------------------------------
-- TRIGGERS: updated_at maintenance
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_workspaces_updated
    BEFORE UPDATE ON public.workspaces
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_batches_updated
    BEFORE UPDATE ON public.batches
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_sims_updated
    BEFORE UPDATE ON public.sims
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- TRIGGER: keep user_roles in sync with workspace_members
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_user_roles()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    INSERT INTO public.user_roles (user_id, roles, workspace_ids, updated_at)
    SELECT
      wm.user_id,
      ARRAY_AGG(DISTINCT wm.role::text),
      ARRAY_AGG(DISTINCT wm.workspace_id),
      NOW()
    FROM public.workspace_members wm
    WHERE wm.user_id = NEW.user_id AND wm.removed_at IS NULL
    GROUP BY wm.user_id
    ON CONFLICT (user_id) DO UPDATE
      SET roles = EXCLUDED.roles,
          workspace_ids = EXCLUDED.workspace_ids,
          updated_at = NOW();
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    DELETE FROM public.user_roles WHERE user_id = OLD.user_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_sync_user_roles
    AFTER INSERT OR UPDATE OR DELETE ON public.workspace_members
    FOR EACH ROW EXECUTE FUNCTION public.sync_user_roles();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- SEED: Networks
-- ----------------------------------------------------------------------------
INSERT INTO public.networks (code, display_name, country_code, msisdn_prefixes, iccid_prefixes)
VALUES
  ('AIRTEL',    'Airtel Kenya',    'KE', ARRAY['+25473','+25478'], ARRAY['89254']),
  ('SAFARICOM', 'Safaricom',       'KE', ARRAY['+25470','+25471','+25472','+25479','+25474','+25475'], ARRAY['89254']),
  ('TELKOM',    'Telkom Kenya',    'KE', ARRAY['+25477'],          ARRAY['89254']),
  ('EQUITEL',   'Equitel',         'KE', ARRAY['+25476'],          ARRAY['89254'])
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================