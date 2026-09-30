-- #7489: bind human API keys to a dedicated CREDENTIAL epoch instead of the
-- session epoch.
--
-- 2026-11-05-101100-api-key-creator-credential-epoch.sql bound each human key
-- to its creator's users.auth_epoch, intending "a password change/reset kills
-- the key". But auth_epoch is the session epoch: ordinary logout (a global
-- sign-out), a role change, an email change, org merge and more all advance
-- it, so the next time a user signed out every API key they had minted failed
-- with "API key creator credentials have changed".
--
-- users.credential_epoch is advanced only where the sign-in credential is
-- replaced or voided (password change/reset, invite acceptance, admin status
-- change) -- see services/authLifecycle.ts. api_keys.creator_credential_epoch
-- is its mint-time snapshot, enforced by middleware/apiKeyAuth.ts together
-- with the existing creator_mfa_epoch.
--
-- Backfill is deliberately conservative: a key gets a credential snapshot only
-- where its creator_auth_epoch still equals the creator's live auth_epoch,
-- i.e. the key is valid right now. A key whose auth_epoch already mismatches
-- is left with a NULL credential snapshot, so the middleware keeps enforcing
-- its original auth_epoch binding and it stays invalid: nothing proves that
-- mismatch came from a harmless logout rather than a password change, so no
-- key is revived. Its owner mints a replacement. Keys with a NULL
-- creator_auth_epoch predate epoch binding and stay unchecked, as before.
DO $$
DECLARE
  n int;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'credential_epoch'
  ) THEN
    ALTER TABLE users ADD COLUMN credential_epoch integer NOT NULL DEFAULT 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = 'creator_credential_epoch'
  ) THEN
    ALTER TABLE api_keys ADD COLUMN creator_credential_epoch integer;
  END IF;

  UPDATE api_keys ak
  SET creator_credential_epoch = u.credential_epoch
  FROM users u
  WHERE ak.created_by = u.id
    AND ak.principal_type = 'human'
    AND ak.creator_credential_epoch IS NULL
    AND ak.creator_auth_epoch IS NOT NULL
    AND ak.creator_auth_epoch = u.auth_epoch;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled creator_credential_epoch baseline on % api_keys rows', n; END IF;
END $$;
