-- AI chargeback W10 (#7608, spec §8): the client price for AI usage lives on the
-- billing profile ("card", #4628). An org's AI price is its card's, resolved by
-- the same selectCard() rule as labour; there is no org-owned AI price.
--
-- TENANCY: billing_profile_ai_rates is shape 3 (partner-axis), registered in
-- PARTNER_TENANT_TABLES, with the same policy as billing_profile_rules. It has
-- no org_id, so it owes no org cascade / export / merge entry. Partner erasure
-- discovers partner_id and orders deletes from real FK edges (the rule rows'
-- precedent); the composite FK to billing_profiles cascades.
--
-- DDL only (no row writes, so no breeze.scope election), idempotent.

ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS ai_coverage text NOT NULL DEFAULT 'non_billable';
ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS ai_markup_percent numeric(7,2);

ALTER TABLE billing_profiles DROP CONSTRAINT IF EXISTS billing_profiles_ai_coverage_chk;
ALTER TABLE billing_profiles ADD CONSTRAINT billing_profiles_ai_coverage_chk
  CHECK (ai_coverage IN ('billable', 'included', 'non_billable'));

-- A markup is a price, so (like base_hourly_rate) it exists only on a billable card.
ALTER TABLE billing_profiles DROP CONSTRAINT IF EXISTS billing_profiles_ai_markup_chk;
ALTER TABLE billing_profiles ADD CONSTRAINT billing_profiles_ai_markup_chk
  CHECK (ai_markup_percent IS NULL
         OR (ai_coverage = 'billable' AND ai_markup_percent >= 0 AND ai_markup_percent <= 1000));

CREATE TABLE IF NOT EXISTS billing_profile_ai_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  billing_profile_id uuid NOT NULL,
  -- Matched against ai_invocations.served_model: the model that actually served.
  model_id text NOT NULL,
  input_price_per_m numeric(14,6) NOT NULL,
  output_price_per_m numeric(14,6) NOT NULL,
  cache_read_price_per_m numeric(14,6) NOT NULL,
  cache_write_price_per_m numeric(14,6) NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_profile_ai_rates_model_not_blank_chk CHECK (btrim(model_id) <> ''),
  CONSTRAINT billing_profile_ai_rates_non_negative_chk CHECK (
    input_price_per_m >= 0 AND output_price_per_m >= 0
    AND cache_read_price_per_m >= 0 AND cache_write_price_per_m >= 0)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_ai_rates_profile_model_uniq') THEN
    ALTER TABLE billing_profile_ai_rates ADD CONSTRAINT billing_profile_ai_rates_profile_model_uniq
      UNIQUE (billing_profile_id, model_id);
  END IF;
END $$;

-- FK checks bypass RLS, so same-partner integrity is structural (billing-profiles spec §4.2).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_ai_rates_profile_partner_fk') THEN
    ALTER TABLE billing_profile_ai_rates ADD CONSTRAINT billing_profile_ai_rates_profile_partner_fk
      FOREIGN KEY (billing_profile_id, partner_id) REFERENCES billing_profiles (id, partner_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS billing_profile_ai_rates_partner_idx ON billing_profile_ai_rates (partner_id);

ALTER TABLE billing_profile_ai_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profile_ai_rates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'billing_profile_ai_rates' AND policyname = 'billing_profile_ai_rates_partner_access'
  ) THEN
    CREATE POLICY billing_profile_ai_rates_partner_access ON billing_profile_ai_rates
      FOR ALL TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_profile_ai_rates TO breeze_app;
