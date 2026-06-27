-- Store the SentinelOne site registration token (deploy token) per mapped org.
-- Encrypted at the application layer via secretCrypto (AAD s1_org_mappings.registration_token).
ALTER TABLE s1_org_mappings
  ADD COLUMN IF NOT EXISTS registration_token text;
