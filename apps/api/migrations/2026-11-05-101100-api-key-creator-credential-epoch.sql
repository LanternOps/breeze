-- Bind each human-delegated API key to the credential-state epochs its
-- creator held at mint time, so a password change/reset or an MFA factor
-- reset invalidates keys minted before it, the same way it already
-- invalidates refresh-token families and live remote-control sessions.
--
-- creator_auth_epoch mirrors users.auth_epoch, which advanceUserEpochs bumps
-- together on both password reset and password change (routes/auth/
-- password.ts) -- one column covers both. creator_mfa_epoch mirrors
-- users.mfa_epoch, bumped by invalidateMfaAssuranceAfterFactorChange on every
-- MFA factor add/remove/reset path. Both are NULL for service-principal keys
-- (principal_type='service'), which are authorized against the principal's
-- own live status, never a human creator's epochs.
--
-- Backfill: every existing active, human-delegated key is stamped with its
-- creator's CURRENT epoch values as its baseline. This does not retroactively
-- revoke any key (a key's stored epoch always equals the creator's live epoch
-- immediately after this migration runs), but it means the very next
-- credential change for that creator is the first one this key does not
-- survive, without a mass key revocation at deploy time.
DO $$
DECLARE
  n int;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'creator_auth_epoch'
  ) THEN
    ALTER TABLE api_keys ADD COLUMN creator_auth_epoch integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'creator_mfa_epoch'
  ) THEN
    ALTER TABLE api_keys ADD COLUMN creator_mfa_epoch integer;
  END IF;

  UPDATE api_keys ak
  SET creator_auth_epoch = u.auth_epoch,
      creator_mfa_epoch = u.mfa_epoch
  FROM users u
  WHERE ak.created_by = u.id
    AND ak.principal_type = 'human'
    AND ak.creator_auth_epoch IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled creator_auth_epoch/creator_mfa_epoch baseline on % api_keys rows', n; END IF;
END $$;
