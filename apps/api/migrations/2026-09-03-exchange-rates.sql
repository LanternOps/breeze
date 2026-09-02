-- Global reporting-only FX reference data (multi-currency spec §8,
-- docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md).
--
-- Tenancy: platform-global public reference data with NO org_id, partner_id or
-- device_id axis. Mirrors supported_currencies (2026-08-27-a): forced RLS,
-- permissive public SELECT (rows contain no tenant data; ordinary org-scoped
-- request contexts read them to render an approximate reporting total),
-- system-context-only writes. Registered in INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts. No org_id/device_id column, so no cascade,
-- device-cascade or export-policy registration applies.
--
-- One authoritative cell per (rate_date, base_code, quote_code); `source`
-- records provenance. Manual precedence is enforced by the feed upsert's
-- `WHERE exchange_rates.source <> 'manual'` conflict predicate in
-- exchangeRateService.upsertFeedRates, not by row multiplicity.
--
-- Idempotent: IF NOT EXISTS + DROP POLICY IF EXISTS. No inner BEGIN/COMMIT.
-- No UPDATE/DELETE/backfill statements, so no GET DIAGNOSTICS reporting block
-- is required.

CREATE TABLE IF NOT EXISTS exchange_rates (
  rate_date date NOT NULL,
  base_code char(3) NOT NULL REFERENCES supported_currencies(code),
  quote_code char(3) NOT NULL REFERENCES supported_currencies(code),
  rate numeric(18,8) NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rates_pkey PRIMARY KEY (rate_date, base_code, quote_code),
  CONSTRAINT exchange_rates_positive_rate_chk CHECK (rate > 0),
  CONSTRAINT exchange_rates_distinct_codes_chk CHECK (base_code <> quote_code),
  CONSTRAINT exchange_rates_source_chk CHECK (source IN ('ecb', 'manual'))
);

-- The only read path is "latest rate on or before <date> for this pair"; the
-- PK's leading rate_date cannot serve it.
CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (base_code, quote_code, rate_date DESC);

ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_rates_read ON exchange_rates;
CREATE POLICY exchange_rates_read ON exchange_rates
  FOR SELECT USING (true);

DROP POLICY IF EXISTS exchange_rates_system_write ON exchange_rates;
CREATE POLICY exchange_rates_system_write ON exchange_rates
  FOR ALL
  USING (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
