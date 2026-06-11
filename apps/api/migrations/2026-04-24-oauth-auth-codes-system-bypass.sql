-- 2026-04-24: oauth_authorization_codes — allow system scope bypass on RLS.
--
-- The original policy only permitted (user_id = breeze_current_user_id()).
-- Auth codes are minted by oidc-provider during the /oauth/auth/<uid> resume
-- request, which runs in our Hono bridge under system DB scope (the adapter
-- uses runOutsideDbContext + withSystemDbAccessContext so it isn't bound to
-- the consenting user's request scope). With breeze.user_id unset, the WITH
-- CHECK clause failed and every code-mint returned a 500.
--
-- Fix: mirror the `sessions` policy shape — user-scope OR system-scope. The
-- auth code id is itself a high-entropy random nonce (oidc-provider mints
-- ~43-char URL-safe strings) so id-only lookups don't leak across users; the
-- user_id column remains the canonical tenancy axis when accessed under a
-- user scope.
--
-- Idempotent. Safe to re-run.

BEGIN;

DROP POLICY IF EXISTS oauth_auth_codes_user_access ON oauth_authorization_codes;

DO $$ BEGIN
  CREATE POLICY oauth_auth_codes_user_access ON oauth_authorization_codes
    FOR ALL TO breeze_app
    USING (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
    WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
