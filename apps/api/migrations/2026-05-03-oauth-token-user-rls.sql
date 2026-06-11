-- 2026-05-03: Tighten OAuth token-row RLS away from generic org-axis access.
--
-- oauth_authorization_codes, oauth_grants, and oauth_refresh_tokens carry
-- partner_id/org_id metadata for lifecycle filtering and audit context, but
-- the rows are user/client OAuth secrets. Generic tenant-scoped DB contexts
-- must not be able to read every user's OAuth rows through either the org or
-- partner axis. Tenant-wide revocation paths are expected to run through
-- explicit system DB context after app-layer authorization.
--
-- Idempotent. Safe to re-run.

BEGIN;

ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oauth_auth_codes_user_access ON oauth_authorization_codes;
DO $$ BEGIN
  CREATE POLICY oauth_auth_codes_user_access ON oauth_authorization_codes
    FOR ALL TO breeze_app
    USING (
      user_id = breeze_current_user_id()
      OR breeze_current_scope() = 'system'
    )
    WITH CHECK (
      user_id = breeze_current_user_id()
      OR breeze_current_scope() = 'system'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP POLICY IF EXISTS oauth_grants_partner_access ON oauth_grants;
DO $$ BEGIN
  CREATE POLICY oauth_grants_partner_access ON oauth_grants
    FOR ALL TO breeze_app
    USING (
      breeze_current_scope() = 'system'
      OR account_id = breeze_current_user_id()
    )
    WITH CHECK (
      breeze_current_scope() = 'system'
      OR account_id = breeze_current_user_id()
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP POLICY IF EXISTS oauth_refresh_tokens_partner_access ON oauth_refresh_tokens;
DO $$ BEGIN
  CREATE POLICY oauth_refresh_tokens_partner_access ON oauth_refresh_tokens
    FOR ALL TO breeze_app
    USING (
      breeze_current_scope() = 'system'
      OR user_id = breeze_current_user_id()
    )
    WITH CHECK (
      breeze_current_scope() = 'system'
      OR user_id = breeze_current_user_id()
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
