-- partner_billing_fraud_flags: core's ledger of the billing fraud flags it has
-- acted on (billing#51). One row per billing flag id (the idempotency key for
-- the partner-trust-fraud-flags job), recording what core did with it:
--   * restricted          — the flag moved the partner to `restricted`; the
--                           trust state it moved FROM is kept so a platform
--                           admin can restore it in one click.
--   * already_restricted  — the partner was already restricted.
--   * suppressed          — an admin restore already cleared this Stripe object.
-- A restore stamps restored_at on the rows of that restriction; a later flag
-- for the same (partner, stripe object) is then suppressed, not re-restricted.
--
-- System-scoped: forced RLS with a system-only policy (mirrors
-- partner_abuse_signals). Partners must never read why they were restricted.
-- All access goes through withSystemDbAccessContext. partner_id cascades on
-- partner hard-delete; no org_id, so no org cascade/merge/export registration.
-- Idempotent.

CREATE TABLE IF NOT EXISTS partner_billing_fraud_flags (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                  uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  billing_flag_id             uuid NOT NULL,
  flag_kind                   varchar(64) NOT NULL,
  restrict_reason             varchar(64) NOT NULL,
  stripe_object_id            varchar(255) NOT NULL,
  stripe_charge_id            varchar(255),
  billing_flagged_at          timestamptz,
  outcome                     varchar(32) NOT NULL,
  previous_trust_state        varchar(16),
  restricted_trust_changed_at timestamptz,
  effects_done_at             timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  restored_at                 timestamptz,
  restored_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  restore_reason              varchar(500),
  CONSTRAINT partner_billing_fraud_flags_outcome_chk
    CHECK (outcome IN ('restricted', 'already_restricted', 'suppressed')),
  -- A `restricted` row must carry the state to restore and the trust
  -- transition it created; no other outcome may.
  CONSTRAINT partner_billing_fraud_flags_restricted_shape_chk
    CHECK (
      (outcome = 'restricted') = (previous_trust_state IS NOT NULL)
      AND (outcome = 'restricted') = (restricted_trust_changed_at IS NOT NULL)
      AND (previous_trust_state IS NULL OR previous_trust_state IN ('probation', 'trusted'))
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_billing_fraud_flags_billing_flag_uq
  ON partner_billing_fraud_flags(billing_flag_id);

CREATE INDEX IF NOT EXISTS partner_billing_fraud_flags_partner_object_idx
  ON partner_billing_fraud_flags(partner_id, stripe_object_id);

CREATE INDEX IF NOT EXISTS partner_billing_fraud_flags_partner_created_idx
  ON partner_billing_fraud_flags(partner_id, created_at);

ALTER TABLE partner_billing_fraud_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_billing_fraud_flags FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_billing_fraud_flags'
      AND policyname = 'partner_billing_fraud_flags_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY partner_billing_fraud_flags_system_only
        ON partner_billing_fraud_flags
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
