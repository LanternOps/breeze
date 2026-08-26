-- #4018: third sso_sessions mode. A "reauth" transaction proves a passwordless
-- SSO account's identity through a fresh IdP round-trip so the user can enroll
-- a FIRST MFA factor. Mirrors link mode (link_user_id + the three initiating_*
-- binding columns), which this reuses as-is.
--
-- ON DELETE CASCADE for the same reason link_user_id has it: sso_sessions has
-- no org_id/partner_id, so the tenant-erasure sweep never reaches it by tenancy
-- and an abandoned transaction must not block a hard user delete.
ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS reauth_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- A session is exactly one of: login (both NULL), link, or reauth. Both set is
-- a programming error that would make the callback's mode discriminator
-- ambiguous, so refuse it in the database rather than ordering the checks.
DO $$
BEGIN
  ALTER TABLE sso_sessions
    ADD CONSTRAINT sso_sessions_single_mode_chk
    CHECK (link_user_id IS NULL OR reauth_user_id IS NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS sso_sessions_reauth_user_id_idx
  ON sso_sessions (reauth_user_id)
  WHERE reauth_user_id IS NOT NULL;
