-- Fail-closed Stripe Checkout session revocation (SEC-2026-09-05-150).
--
-- A Checkout session stays provider-payable after Breeze resets the public
-- link, records an alternate payment, voids the invoice or replaces/removes the
-- Stripe key. Local settlement protects the Breeze ledger but cannot prevent a
-- provider charge. This adds the durable revocation intent + retry ladder to the
-- session mapping, and a partner-axis archive so a superseded key can still
-- expire the sessions it minted.

DO $$ BEGIN
  CREATE TYPE stripe_session_revocation_state AS ENUM (
    'active', 'revocation_requested', 'revoked',
    'revocation_blocked', 'charged_repair', 'legacy_unbounded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Partner-axis archive of superseded Stripe credentials (RLS shape 3).
-- No org_id: neither the org cascade nor the export policy registry applies.
-- cascadeDeletePartner's information_schema-driven partner_id sweep reaches it
-- automatically, so tenant erasure always wins over the retention window below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_connect_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  stripe_connection_id UUID NOT NULL,
  stripe_account_id TEXT NOT NULL,
  -- Encrypted via secretCrypto, exactly like stripe_connect_accounts.api_key.
  -- NULL once the eraser has run: the row survives as a forensic record of what
  -- was retained and when it went away.
  api_key TEXT,
  key_last4 VARCHAR(4),
  livemode BOOLEAN NOT NULL DEFAULT FALSE,
  -- Monotonic per connection. Generation 1 is the first key ever superseded on
  -- that connection; the live key is always generation max+1 and is NOT stored here.
  generation INTEGER NOT NULL,
  superseded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Earliest moment the secret may be destroyed (superseded_at + 120 days,
  -- Stripe's outer dispute window). The eraser additionally requires every
  -- dependent session mapping to be terminal, and destroys unconditionally at
  -- the 400-day hard cap.
  erase_after TIMESTAMPTZ NOT NULL,
  erase_hard_cap_at TIMESTAMPTZ NOT NULL,
  erased_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE stripe_connect_credentials
    ADD CONSTRAINT stripe_connect_credentials_connection_partner_fk
    FOREIGN KEY (stripe_connection_id, partner_id)
    REFERENCES stripe_connect_accounts(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_credentials_generation_uq
  ON stripe_connect_credentials (stripe_connection_id, generation);
CREATE INDEX IF NOT EXISTS stripe_connect_credentials_partner_idx
  ON stripe_connect_credentials (partner_id);
CREATE INDEX IF NOT EXISTS stripe_connect_credentials_account_idx
  ON stripe_connect_credentials (stripe_account_id);
-- Eraser feed: only rows that still hold a secret are candidates.
CREATE INDEX IF NOT EXISTS stripe_connect_credentials_erase_idx
  ON stripe_connect_credentials (erase_after)
  WHERE erased_at IS NULL;

ALTER TABLE stripe_connect_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stripe_connect_credentials_select ON stripe_connect_credentials;
DROP POLICY IF EXISTS stripe_connect_credentials_system_insert ON stripe_connect_credentials;
DROP POLICY IF EXISTS stripe_connect_credentials_system_update ON stripe_connect_credentials;
DROP POLICY IF EXISTS stripe_connect_credentials_system_delete ON stripe_connect_credentials;
CREATE POLICY stripe_connect_credentials_select ON stripe_connect_credentials
  FOR SELECT TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
CREATE POLICY stripe_connect_credentials_system_insert ON stripe_connect_credentials
  FOR INSERT TO breeze_app
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY stripe_connect_credentials_system_update ON stripe_connect_credentials
  FOR UPDATE TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY stripe_connect_credentials_system_delete ON stripe_connect_credentials
  FOR DELETE TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );

-- ---------------------------------------------------------------------------
-- Durable revocation intent + retry ladder on the session mapping.
-- ---------------------------------------------------------------------------
ALTER TABLE invoice_stripe_payments
  ADD COLUMN IF NOT EXISTS revocation_state stripe_session_revocation_state NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT,
  ADD COLUMN IF NOT EXISTS revocation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revocation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revocation_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revocation_last_error TEXT,
  ADD COLUMN IF NOT EXISTS revocation_last_provider_code TEXT,
  ADD COLUMN IF NOT EXISTS revocation_requested_by_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS revocation_credential_id UUID REFERENCES stripe_connect_credentials(id),
  ADD COLUMN IF NOT EXISTS provider_expires_at TIMESTAMPTZ;

-- Worker feed. Partial: only requested rows are ever drained, so the index stays
-- tiny even though the table grows with every payment.
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_revocation_due_idx
  ON invoice_stripe_payments (revocation_next_attempt_at, id)
  WHERE revocation_state = 'revocation_requested';

-- Detection and DML below are blind under RLS without a system scope
-- (managed-Postgres roles are not superusers; CI's superuser masks this).
SELECT set_config('breeze.scope', 'system', true);

-- Legacy inventory. Stripe expires an unclaimed Checkout session after 24h, so
-- anything past 30 days can only answer resource_missing — mark it terminal now
-- rather than spending a provider call on it. Rows between the reconcile
-- sweep's 7-day horizon and 30 days are `legacy_unbounded`: revocable, but
-- flagged as pre-dating the intent contract.
DO $$
DECLARE aged BIGINT; legacy BIGINT;
BEGIN
  UPDATE invoice_stripe_payments
  SET revocation_state = 'revoked',
      revocation_reason = 'aged_out',
      revoked_at = NOW(),
      updated_at = NOW()
  WHERE status = 'pending'
    AND stripe_object_type = 'checkout_session'
    AND invoice_payment_id IS NULL
    AND revocation_state = 'active'
    AND created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS aged = ROW_COUNT;
  IF aged > 0 THEN
    RAISE WARNING 'checkout-session-revocation: marked % aged-out pending session mapping(s) revoked', aged;
  END IF;

  UPDATE invoice_stripe_payments
  SET revocation_state = 'legacy_unbounded',
      updated_at = NOW()
  WHERE status = 'pending'
    AND stripe_object_type = 'checkout_session'
    AND invoice_payment_id IS NULL
    AND revocation_state = 'active'
    AND created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS legacy = ROW_COUNT;
  IF legacy > 0 THEN
    RAISE WARNING 'checkout-session-revocation: flagged % pre-contract pending session mapping(s) legacy_unbounded', legacy;
  END IF;
END $$;
