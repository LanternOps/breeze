-- Task 7 (launch-readiness fixes): refresh-token family revocation.
--
-- Tracks the chain of refresh tokens issued from each /login. Every
-- token in the chain shares the same family_id; when an already-revoked
-- jti is replayed (token reuse / RFC 9700 §4.13.2), the entire family
-- is revoked rather than just the replayed jti — closing the race in
-- which an attacker who steals a refresh cookie could hold a parallel
-- session by refreshing once before the legitimate user.
--
-- RLS shape: 6 (user-id scoped) — same pattern as approval_requests and
-- account_deletion_requests. The policy gates every command on
-- breeze_current_user_id(); system-scoped writes (reuse-detection in
-- /refresh) go through withSystemDbAccessContext to bypass.
--
-- Idempotent: safe to re-apply on a database that has already been migrated.

CREATE TABLE IF NOT EXISTS refresh_token_families (
  family_id      uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason varchar(64)
);

CREATE INDEX IF NOT EXISTS refresh_token_families_user_idx
  ON refresh_token_families(user_id);

ALTER TABLE refresh_token_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token_families FORCE ROW LEVEL SECURITY;

-- Shape-6 policy with a system-scope OR branch. The `/login` mint-family
-- path runs before any user-scope is established (it's still in the
-- pre-auth section of the handler), and the reuse-detection /refresh path
-- writes revoked_at via withSystemDbAccessContext. Without the OR-system
-- branch every such write would fail RLS under the unprivileged breeze_app
-- role — same trap as PR #696 (approval_requests + account_deletion_requests).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'refresh_token_families'
      AND policyname = 'refresh_token_families_user_scope'
  ) THEN
    CREATE POLICY refresh_token_families_user_scope ON refresh_token_families
      FOR ALL
      TO breeze_app
      USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
      WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
  END IF;
END $$;
