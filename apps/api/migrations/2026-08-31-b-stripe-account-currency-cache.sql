-- Multi-currency wave 5 (#3777, spec §10): cache the connected Stripe account's
-- default_currency + country (retrieved when the API key is saved, refreshed
-- on demand / after a TTL) so checkout can warn when a document's currency
-- differs from what the account settles in. A cache of an external fact —
-- deliberately NOT FK'd to supported_currencies. Partner-axis table; RLS and
-- policies already in place (2026-06-16-stripe-payments.sql).
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS default_currency char(3);
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS account_country char(2);
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS account_refreshed_at timestamp;
