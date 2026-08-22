-- Global allowlist of supported ISO-4217 currency codes (multi-currency spec §4,
-- docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md).
-- Kept in parity with CURRENCY_CODES in packages/shared/src/utils/currency.ts by
-- supportedCurrencies.integration.test.ts. Adding a currency = a new migration
-- INSERTing the row (plus the shared-list change in the same PR).
--
-- Tenancy: platform-global reference data, no tenant axis. Mirrors
-- winget_package_index (2026-08-16-c): forced RLS, permissive public SELECT
-- (rows contain no tenant data; ordinary org-scoped request contexts read it),
-- system-context-only writes. Registered in INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts. No org_id/device_id column, so no cascade,
-- device-cascade or export-policy registration applies.
--
-- Idempotent: IF NOT EXISTS + ON CONFLICT DO NOTHING + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS supported_currencies (
  code char(3) PRIMARY KEY,
  CONSTRAINT supported_currencies_code_format_chk CHECK (code ~ '^[A-Z]{3}$')
);

INSERT INTO supported_currencies (code) VALUES
  ('AED'), ('ARS'), ('AUD'), ('BRL'), ('CAD'), ('CHF'), ('CLP'), ('COP'),
  ('CZK'), ('DKK'), ('EUR'), ('GBP'), ('HKD'), ('HUF'), ('IDR'), ('ILS'),
  ('INR'), ('JPY'), ('KES'), ('MXN'), ('MYR'), ('NGN'), ('NOK'), ('NZD'),
  ('PHP'), ('PLN'), ('RON'), ('SAR'), ('SEK'), ('SGD'), ('THB'), ('TRY'),
  ('USD'), ('ZAR')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE supported_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE supported_currencies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supported_currencies_read ON supported_currencies;
CREATE POLICY supported_currencies_read ON supported_currencies
  FOR SELECT USING (true);

DROP POLICY IF EXISTS supported_currencies_system_write ON supported_currencies;
CREATE POLICY supported_currencies_system_write ON supported_currencies
  FOR ALL
  USING (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
