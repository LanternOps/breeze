-- 2026-05-16: approval_requests + account_deletion_requests — add a
-- system-scope bypass to the Shape-6 user-scoped RLS policies.
--
-- PR #696 Critical #1 / #2. The policies created by
-- 2026-05-06-approval-requests.sql and 2026-05-07-account-deletion-requests.sql
-- were:
--
--   USING (user_id = breeze_current_user_id())
--   WITH CHECK (user_id = breeze_current_user_id())
--
-- with NO system-scope OR branch. Two non-request code paths run under
-- SYSTEM DB scope, where breeze.user_id is unset so breeze_current_user_id()
-- is NULL and `user_id = NULL` matches zero rows under FORCE RLS for the
-- unprivileged breeze_app role:
--
--   * approvalExpiryReaper (BullMQ worker via withSystemDbAccessContext) —
--     the bounded UPDATE...FROM transitioned 0 rows every run, so expired
--     approvals were never reaped and mobile-only approvals always burned
--     the full waitForApproval ceiling.
--   * the account-deletion admin queue (routes/auth/accountDeletion.ts via
--     runWithSystemDbAccess) — list/get/process all returned empty/404, so
--     admins could never see or action a deletion request.
--
-- Fix: mirror the oauth_authorization_codes (2026-04-24) / sessions policy
-- shape by adding `OR breeze_current_scope() = 'system'` to both USING and
-- WITH CHECK. user_id remains the canonical tenancy axis under any user
-- scope; only genuine system-scope contexts (background workers, the admin
-- queue) gain access. No cross-user exposure: a request-scoped caller always
-- has breeze.scope != 'system', so the user_id predicate still governs.
--
-- Idempotent: DROP POLICY IF EXISTS then recreate with a deterministic body.
-- Re-applying is a true no-op. autoMigrate wraps each file in a transaction,
-- so no inner BEGIN/COMMIT.

DROP POLICY IF EXISTS approval_requests_user_scope ON approval_requests;
DO $$ BEGIN
  CREATE POLICY approval_requests_user_scope ON approval_requests
    USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
    WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP POLICY IF EXISTS account_deletion_requests_user_scope ON account_deletion_requests;
DO $$ BEGIN
  CREATE POLICY account_deletion_requests_user_scope ON account_deletion_requests
    USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
    WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
