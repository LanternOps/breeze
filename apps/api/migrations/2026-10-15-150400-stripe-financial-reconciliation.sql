-- Durable Stripe refund/dispute observation and monotonic invoice reconciliation.

ALTER TYPE stripe_payment_status ADD VALUE IF NOT EXISTS 'disputed';
ALTER TYPE stripe_payment_status ADD VALUE IF NOT EXISTS 'partially_disputed';

DO $$ BEGIN
  CREATE TYPE stripe_financial_event_status AS ENUM ('pending', 'applied', 'ignored', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE stripe_connect_accounts
  ADD COLUMN IF NOT EXISTS financial_event_cursor_created BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_event_page_after TEXT,
  ADD COLUMN IF NOT EXISTS financial_event_scan_upper_created BIGINT,
  ADD COLUMN IF NOT EXISTS financial_event_last_polled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS financial_event_last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_id_partner_uq
  ON stripe_connect_accounts (id, partner_id);

ALTER TABLE invoice_stripe_payments
  ADD COLUMN IF NOT EXISTS refunded_amount_minor NUMERIC(20,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispute_amount_minor NUMERIC(20,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispute_funds_withdrawn BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_dispute_event_created BIGINT,
  ADD COLUMN IF NOT EXISTS last_dispute_event_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_received_at DATE;

-- Detection reads are blind under RLS without a system scope.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n BIGINT;
BEGIN
  SELECT COUNT(*) INTO n FROM (
    SELECT 1 FROM invoice_stripe_payments
    WHERE stripe_payment_intent_id IS NOT NULL
    GROUP BY stripe_account_id, stripe_payment_intent_id
    HAVING COUNT(*) > 1
  ) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'invoice_stripe_payments has % duplicate (stripe_account_id, stripe_payment_intent_id) pairs; resolve them before applying the unique index', n;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_stripe_payments_account_pi_uq
  ON invoice_stripe_payments (stripe_account_id, stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_financial_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  stripe_connection_id UUID NOT NULL,
  stripe_account_id TEXT NOT NULL,
  stripe_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  provider_created BIGINT NOT NULL,
  payment_intent_id TEXT,
  charge_id TEXT,
  dispute_id TEXT,
  currency CHAR(3) NOT NULL,
  charge_amount_minor NUMERIC(20,0),
  refunded_amount_minor NUMERIC(20,0),
  dispute_amount_minor NUMERIC(20,0),
  dispute_funds_withdrawn BOOLEAN,
  payload_digest CHAR(64) NOT NULL,
  status stripe_financial_event_status NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A dev/test database may already carry the pre-quarantine NOT NULL form.
-- Refund/dispute events on legacy charges with no PaymentIntent are now
-- quarantined as `blocked` rows rather than throwing inside the poll loop.
ALTER TABLE stripe_financial_events ALTER COLUMN payment_intent_id DROP NOT NULL;

ALTER TABLE stripe_financial_events
  ADD COLUMN IF NOT EXISTS stripe_connection_id UUID,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE stripe_financial_events
  DROP CONSTRAINT IF EXISTS stripe_financial_events_partner_account_fk;
ALTER TABLE stripe_financial_events
  DROP CONSTRAINT IF EXISTS stripe_financial_events_connection_fk;

SELECT set_config('breeze.scope', 'system', true);

UPDATE stripe_financial_events e
SET stripe_connection_id = c.id
FROM stripe_connect_accounts c
WHERE e.stripe_connection_id IS NULL
  AND c.partner_id = e.partner_id
  AND c.stripe_account_id = e.stripe_account_id;

ALTER TABLE stripe_financial_events ALTER COLUMN stripe_connection_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE stripe_financial_events
    ADD CONSTRAINT stripe_financial_events_connection_partner_fk
    FOREIGN KEY (stripe_connection_id, partner_id)
    REFERENCES stripe_connect_accounts(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_financial_events_event_uq
  ON stripe_financial_events (stripe_event_id);
CREATE INDEX IF NOT EXISTS stripe_financial_events_pending_retry_idx
  ON stripe_financial_events (status, next_attempt_at, provider_created);
CREATE INDEX IF NOT EXISTS stripe_financial_events_connection_idx
  ON stripe_financial_events (stripe_connection_id);
CREATE INDEX IF NOT EXISTS stripe_financial_events_partner_idx
  ON stripe_financial_events (partner_id);
CREATE INDEX IF NOT EXISTS stripe_financial_events_pi_idx
  ON stripe_financial_events (stripe_account_id, payment_intent_id);

ALTER TABLE stripe_financial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_financial_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stripe_financial_events_partner_access ON stripe_financial_events;
DROP POLICY IF EXISTS stripe_financial_events_select ON stripe_financial_events;
DROP POLICY IF EXISTS stripe_financial_events_system_insert ON stripe_financial_events;
DROP POLICY IF EXISTS stripe_financial_events_system_update ON stripe_financial_events;
DROP POLICY IF EXISTS stripe_financial_events_system_delete ON stripe_financial_events;
CREATE POLICY stripe_financial_events_select ON stripe_financial_events
  FOR SELECT TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
CREATE POLICY stripe_financial_events_system_insert ON stripe_financial_events
  FOR INSERT TO breeze_app
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY stripe_financial_events_system_update ON stripe_financial_events
  FOR UPDATE TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY stripe_financial_events_system_delete ON stripe_financial_events
  FOR DELETE TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
