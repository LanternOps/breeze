-- Stripe billing model change: per-partner API key (self-host friendly) instead of
-- Connect OAuth. The partner stores their OWN Stripe (restricted) secret key; charges
-- run directly on their account with that key — no platform, no Connect, no
-- Stripe-Account header. We reuse the existing partner-axis stripe_connect_accounts
-- table (RLS already in place) and add encrypted-key storage + a display last4.
--
-- `api_key` holds the secret key encrypted via secretCrypto (same scheme as the
-- legacy OAuth access token in `credentials`). `key_last4` is the plaintext last 4
-- chars for the settings UI ("•••• 1234"). The legacy OAuth columns
-- (credentials/scope) are left in place for now and ignored by the new code path;
-- a later migration can drop them once no deployment relies on them.

ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS api_key text;
ALTER TABLE stripe_connect_accounts ADD COLUMN IF NOT EXISTS key_last4 varchar(4);
