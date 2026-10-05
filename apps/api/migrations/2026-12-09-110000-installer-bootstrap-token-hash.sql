-- installer_bootstrap_tokens: store a keyed hash of the token instead of the
-- plaintext.
--
-- New rows write token_hash = HMAC-SHA256(ENROLLMENT_KEY_PEPPER,
-- 'breeze.installer-bootstrap-token.v1:' || token) (services/
-- installerBootstrapToken.ts → hashBootstrapToken) and leave `token` NULL.
-- Redemption matches token_hash, and falls back to `token` only for rows whose
-- token_hash IS NULL — the rows issued before this change, which keep working
-- until their own expires_at and then drain through the existing cleanup.
--
-- No backfill: the hash needs the API's pepper, which the database does not
-- have, and the legacy rows are self-expiring.
--
-- Plain (non-CONCURRENTLY) unique constraint: the new column is all NULL at
-- creation, so the index build is trivial, and the table holds one row per
-- installer download, bounded by parent-key cascade + expiry cleanup.
--
-- No row writes in this file, so no breeze.scope elevation is needed.
-- Idempotent — safe to re-run.

ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'installer_bootstrap_tokens_token_hash_unique'
      AND conrelid = 'public.installer_bootstrap_tokens'::regclass
  ) THEN
    ALTER TABLE installer_bootstrap_tokens
      ADD CONSTRAINT installer_bootstrap_tokens_token_hash_unique UNIQUE (token_hash);
  END IF;
END $$;

ALTER TABLE installer_bootstrap_tokens
  ALTER COLUMN token DROP NOT NULL;

-- Every row must still carry a verifier: a row with neither could never be
-- redeemed and would only mislead the capacity figures.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'installer_bootstrap_tokens_token_or_hash_present'
      AND conrelid = 'public.installer_bootstrap_tokens'::regclass
  ) THEN
    ALTER TABLE installer_bootstrap_tokens
      ADD CONSTRAINT installer_bootstrap_tokens_token_or_hash_present
      CHECK (token IS NOT NULL OR token_hash IS NOT NULL);
  END IF;
END $$;
