-- Customer-portal logout: a durable record of each session ended at logout.
--
-- A portal session is an opaque random token cached in Redis (process memory
-- in development). Logout used to delete that cache entry and nothing else, so
-- a failed delete, a replica that still held the key, or Redis restored from an
-- earlier snapshot left the signed-out token usable until its sliding expiry.
-- Logout now records the token here before answering; portalAuthMiddleware
-- refuses any recorded token, and the cache delete is cleanup only. Other
-- sessions of the same portal user are untouched.
--
-- Only a SHA-256 digest of the token is stored, never the token itself.
-- Rows are kept for 7 days (seven sliding portal-session lifetimes, far past
-- the last moment the cache could still hold the key) and purged a batch at a
-- time by later logouts.
--
-- Tenancy: no org_id. The table is system-only (forced RLS, one system-scope
-- policy), like auth_browser_transitions: it is written by logout and read by
-- the pre-auth portal session lookup, both in system scope, and never by a
-- tenant-scoped request. Org erasure removes its rows through the
-- portal_users foreign key (ON DELETE CASCADE), so it needs no cascade, merge
-- or export registration.

CREATE TABLE IF NOT EXISTS portal_session_revocations (
  token_digest varchar(64) PRIMARY KEY,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT portal_session_revocations_token_digest_chk
    CHECK (token_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS portal_session_revocations_portal_user_idx
  ON portal_session_revocations (portal_user_id);

CREATE INDEX IF NOT EXISTS portal_session_revocations_expires_idx
  ON portal_session_revocations (expires_at);

ALTER TABLE portal_session_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_session_revocations FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'portal_session_revocations'
      AND policyname = 'portal_session_revocations_system_only'
  ) THEN
    CREATE POLICY portal_session_revocations_system_only
      ON portal_session_revocations
      FOR ALL TO breeze_app
      USING (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system');
  END IF;
END $$;
