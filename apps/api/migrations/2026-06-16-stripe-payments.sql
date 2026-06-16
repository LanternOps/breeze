-- apps/api/migrations/2026-06-16-stripe-payments.sql
-- Stripe Payments (billing sub-project 4): connected accounts + payment mapping.

-- ── enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE stripe_connect_status AS ENUM ('connected', 'disconnected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stripe_payment_object_type AS ENUM ('checkout_session', 'payment_intent', 'charge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stripe_payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── stripe_connect_accounts (partner-axis, RLS shape 3) ──────────────────────
CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  stripe_account_id TEXT NOT NULL,
  credentials JSONB,
  livemode BOOLEAN NOT NULL DEFAULT FALSE,
  status stripe_connect_status NOT NULL DEFAULT 'connected',
  scope VARCHAR(50),
  connected_by UUID REFERENCES users(id),
  connected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_partner_uq ON stripe_connect_accounts (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_acct_uq ON stripe_connect_accounts (stripe_account_id);

ALTER TABLE stripe_connect_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY stripe_connect_accounts_partner_access ON stripe_connect_accounts
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── invoice_stripe_payments (org-axis, RLS shape 1) ──────────────────────────
CREATE TABLE IF NOT EXISTS invoice_stripe_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_payment_id UUID REFERENCES invoice_payments(id) ON DELETE SET NULL,
  stripe_account_id TEXT NOT NULL,
  stripe_object_type stripe_payment_object_type NOT NULL,
  stripe_object_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  amount NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status stripe_payment_status NOT NULL DEFAULT 'pending',
  last_event_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_stripe_payments_object_uq ON invoice_stripe_payments (stripe_object_id);
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_invoice_idx ON invoice_stripe_payments (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_org_idx ON invoice_stripe_payments (org_id);
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_pi_idx ON invoice_stripe_payments (stripe_payment_intent_id);

ALTER TABLE invoice_stripe_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_stripe_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_stripe_payments;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_stripe_payments;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_stripe_payments;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_stripe_payments;
CREATE POLICY breeze_org_isolation_select ON invoice_stripe_payments
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_stripe_payments
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_stripe_payments
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_stripe_payments
  FOR DELETE USING (public.breeze_has_org_access(org_id));
