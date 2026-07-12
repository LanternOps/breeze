-- Core authentication hardening PR 1: durable security-state epochs on users
-- and an absolute lifetime cap on refresh-token families. Idempotent.
--
-- Epochs are monotonic counters advanced by the auth-lifecycle service inside
-- the same transaction as the security mutation that invalidates prior
-- credentials (status/password/membership/MFA/email changes). Access & refresh
-- JWTs carry auth_epoch/mfa_epoch; a mismatch on the live row rejects the token.

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_epoch integer NOT NULL DEFAULT 1;

-- Absolute family lifetime: a refresh chain may rotate freely but the family
-- cannot outlive this wall-clock cap regardless of rotation. Existing families
-- get created_at + 30d so no live session is force-killed by the backfill
-- earlier than the new default would have; new rows are stamped by the app at
-- mint time (services/refreshTokenFamily.ts).
ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;

DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE refresh_token_families
     SET absolute_expires_at = created_at + interval '30 days'
   WHERE absolute_expires_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled absolute_expires_at on % refresh_token_families rows', n;
  END IF;
END $$;

ALTER TABLE refresh_token_families ALTER COLUMN absolute_expires_at SET NOT NULL;
