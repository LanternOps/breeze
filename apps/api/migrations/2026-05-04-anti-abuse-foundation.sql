-- Anti-abuse foundation:
--   1. users.is_platform_admin flag (env-bootstrapped at API startup)
--   2. email_verification_tokens table for the signup-email-verify flow
--      (gate post-payment partner activation on email_verified_at)
--
-- All operations idempotent; this migration must be a no-op on re-apply.

-- 1. Platform admin flag on users -------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- Partial index: scanning the (very small) set of platform admins is the
-- only access pattern; keeps the index tiny.
CREATE INDEX IF NOT EXISTS users_is_platform_admin_idx
  ON users (id) WHERE is_platform_admin = true;

-- 2. email_verification_tokens table ----------------------------------------

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  varchar(64) NOT NULL UNIQUE,
  partner_id  uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       varchar(255) NOT NULL,
  expires_at  timestamp NOT NULL,
  consumed_at timestamp,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_partner_idx
  ON email_verification_tokens (partner_id);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx
  ON email_verification_tokens (user_id);

-- Reaper-friendly: only tracks live (unconsumed) tokens for expiry sweeps.
CREATE INDEX IF NOT EXISTS email_verification_tokens_unconsumed_expires_idx
  ON email_verification_tokens (expires_at) WHERE consumed_at IS NULL;

-- RLS: partner-axis (shape #3). Token lookup during /auth/verify-email runs
-- in system scope (no auth context yet) — the partner predicate accepts
-- 'system' scope by design, so verification works pre-login.
ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'email_verification_tokens'
                   AND policyname = 'breeze_evt_isolation_select') THEN
    CREATE POLICY breeze_evt_isolation_select ON email_verification_tokens
      FOR SELECT USING (breeze_has_partner_access(partner_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'email_verification_tokens'
                   AND policyname = 'breeze_evt_isolation_insert') THEN
    CREATE POLICY breeze_evt_isolation_insert ON email_verification_tokens
      FOR INSERT WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'email_verification_tokens'
                   AND policyname = 'breeze_evt_isolation_update') THEN
    CREATE POLICY breeze_evt_isolation_update ON email_verification_tokens
      FOR UPDATE USING (breeze_has_partner_access(partner_id))
                 WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename = 'email_verification_tokens'
                   AND policyname = 'breeze_evt_isolation_delete') THEN
    CREATE POLICY breeze_evt_isolation_delete ON email_verification_tokens
      FOR DELETE USING (breeze_has_partner_access(partner_id));
  END IF;
END $$;
