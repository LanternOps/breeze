-- #12691: SentinelOne and Huntress integrations can be disconnected.
--
-- Disconnect is soft: the integration row stays, because synced agents,
-- threats, incidents and site/org mappings reference it. So that a
-- disconnected row holds no usable secret, the disconnect route sets its
-- credential columns to NULL. The API token / API key columns were NOT NULL,
-- so relax them. A connected row still always carries a credential: the
-- connect route refuses to save one without it.
--
-- Schema only, no row writes. Re-running is a no-op.
ALTER TABLE s1_integrations ALTER COLUMN api_token_encrypted DROP NOT NULL;
ALTER TABLE huntress_integrations ALTER COLUMN api_key_encrypted DROP NOT NULL;
