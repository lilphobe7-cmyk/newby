-- ============================================================================
-- SimFlow -- Subscription (single flat monthly fee for main agents)
-- ============================================================================

-- App-wide settings (key-value)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert defaults (only if not present)
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('subscription_monthly_fee_kes', '{"amount": 500}'::jsonb, 'Flat monthly fee in KES for every main agent workspace'),
  ('subscription_currency',        '{"code": "KES"}'::jsonb, 'Currency code'),
  ('subscription_grace_period_days','{"days": 7}'::jsonb, 'Days after due date before suspension'),
  ('subscription_trial_days',      '{"days": 30}'::jsonb, 'Free trial length for new workspaces')
ON CONFLICT (key) DO NOTHING;

-- Per-workspace subscription
CREATE TABLE IF NOT EXISTS public.workspace_subscriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'TRIAL',
                        -- TRIAL | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED
  monthly_fee_kes       NUMERIC(10, 2) NOT NULL,        -- locked at signup or last renewal
  currency              TEXT NOT NULL DEFAULT 'KES',
  trial_started_at      TIMESTAMPTZ,
  trial_ends_at         TIMESTAMPTZ,
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  next_due_at           TIMESTAMPTZ,
  last_paid_at          TIMESTAMPTZ,
  suspended_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_ws_subs_status ON public.workspace_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_ws_subs_next_due ON public.workspace_subscriptions(next_due_at)
  WHERE status IN ('TRIAL', 'ACTIVE', 'PAST_DUE');

-- Payment records
CREATE TABLE IF NOT EXISTS public.payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.workspace_subscriptions(id) ON DELETE SET NULL,
  amount_kes      NUMERIC(10, 2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'KES',
  method          TEXT NOT NULL,                     -- MPESA | CASH | BANK | MANUAL | OTHER
  reference       TEXT,                              -- e.g. M-Pesa transaction code
  status          TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | CONFIRMED | FAILED | REFUNDED
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  recorded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_workspace ON public.payments(workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);

-- Admin audit log (who changed what, when)
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_type   TEXT NOT NULL,                    -- USER | TELEGRAM | SYSTEM
  actor_id     TEXT NOT NULL,                    -- user UUID or Telegram user id
  action       TEXT NOT NULL,                    -- SET_FEE | RECORD_PAYMENT | SUSPEND | etc.
  target       TEXT,                             -- e.g. workspace UUID
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON public.admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON public.admin_audit_log(actor_type, actor_id);

-- ----------------------------------------------------------------------------
-- Auto-create a subscription when a workspace is created
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_workspace_created()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fee NUMERIC(10, 2);
  v_trial_days INTEGER;
BEGIN
  -- Read current fee and trial period from app_settings
  SELECT (value->>'amount')::NUMERIC INTO v_fee
  FROM public.app_settings WHERE key = 'subscription_monthly_fee_kes';

  SELECT (value->>'days')::INTEGER INTO v_trial_days
  FROM public.app_settings WHERE key = 'subscription_trial_days';

  v_fee := COALESCE(v_fee, 500);
  v_trial_days := COALESCE(v_trial_days, 30);

  INSERT INTO public.workspace_subscriptions (
    workspace_id, status, monthly_fee_kes,
    trial_started_at, trial_ends_at, next_due_at
  ) VALUES (
    NEW.id, 'TRIAL', v_fee,
    NOW(), NOW() + (v_trial_days || ' days')::INTERVAL, NOW() + (v_trial_days || ' days')::INTERVAL
  )
  ON CONFLICT (workspace_id) DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_created ON public.workspaces;
CREATE TRIGGER trg_workspace_created
  AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.on_workspace_created();

-- updated_at triggers
DROP TRIGGER IF EXISTS trg_ws_subs_updated ON public.workspace_subscriptions;
CREATE TRIGGER trg_ws_subs_updated
  BEFORE UPDATE ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS app_settings_read ON public.app_settings;
CREATE POLICY app_settings_read
  ON public.app_settings FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS ws_subs_read ON public.workspace_subscriptions;
CREATE POLICY ws_subs_read
  ON public.workspace_subscriptions FOR SELECT TO authenticated
  USING (
    is_main_agent(workspace_id, auth.uid())
    OR workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid() AND removed_at IS NULL
    )
  );

DROP POLICY IF EXISTS payments_read ON public.payments;
CREATE POLICY payments_read
  ON public.payments FOR SELECT TO authenticated
  USING (is_main_agent(workspace_id, auth.uid()));

DROP POLICY IF EXISTS audit_read ON public.admin_audit_log;
CREATE POLICY audit_read
  ON public.admin_audit_log FOR SELECT TO authenticated
  USING (FALSE);  -- Only visible via service_role; hides from clients entirely

-- ============================================================================
-- END
-- ============================================================================