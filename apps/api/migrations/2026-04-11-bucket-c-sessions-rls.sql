-- 2026-04-11: Bucket C — user auth sessions RLS.
--
-- The `sessions` table stores user authentication sessions (token_hash,
-- expires_at, etc.) keyed on `user_id`. It has no org_id; the only
-- tenancy axis is the user themselves.
--
-- Policy shape (all four verbs):
--   USING / WITH CHECK (
--     user_id = public.breeze_current_user_id()
--     OR public.breeze_current_scope() = 'system'
--   )
--
-- Why system scope instead of the partner/org EXISTS subquery used in
-- Phase 6?  Because sessions are created at login time, BEFORE any
-- request scope is established — the caller has breeze.scope='none' by
-- default.  All session creation paths (login, MFA verify, SSO callback)
-- are wrapped in withSystemDbAccessContext so the INSERT sees scope='system'.
-- The self-read branch (user_id = breeze_current_user_id()) covers every
-- authenticated path that touches its own sessions (validate, invalidate,
-- extend).  System scope covers background jobs, admin cleanup, and the
-- session-creation write path.
--
-- Fully idempotent.

BEGIN;

DROP POLICY IF EXISTS breeze_sessions_select ON sessions;
DROP POLICY IF EXISTS breeze_sessions_insert ON sessions;
DROP POLICY IF EXISTS breeze_sessions_update ON sessions;
DROP POLICY IF EXISTS breeze_sessions_delete ON sessions;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_sessions_select ON sessions
  FOR SELECT USING (
    user_id = public.breeze_current_user_id()
    OR public.breeze_current_scope() = 'system'
  );

CREATE POLICY breeze_sessions_insert ON sessions
  FOR INSERT WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR public.breeze_current_scope() = 'system'
  );

CREATE POLICY breeze_sessions_update ON sessions
  FOR UPDATE
  USING (
    user_id = public.breeze_current_user_id()
    OR public.breeze_current_scope() = 'system'
  )
  WITH CHECK (
    user_id = public.breeze_current_user_id()
    OR public.breeze_current_scope() = 'system'
  );

CREATE POLICY breeze_sessions_delete ON sessions
  FOR DELETE USING (
    user_id = public.breeze_current_user_id()
    OR public.breeze_current_scope() = 'system'
  );

COMMIT;
