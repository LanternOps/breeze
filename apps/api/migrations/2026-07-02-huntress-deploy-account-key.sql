-- Huntress deployment Account Key (used in the installer download URL and /ACCT_KEY).
-- This is a distinct secret from the API account_id; stored encrypted at the app
-- layer via secretCrypto (AAD huntress_integrations.account_key_encrypted).
ALTER TABLE huntress_integrations
  ADD COLUMN IF NOT EXISTS account_key_encrypted text;
