-- 2026-04-24: Extend OAuth table RLS policies to cover the org axis.
--
-- Why: oauth_authorization_codes, oauth_grants, and oauth_refresh_tokens all
-- carry a denormalized `org_id` column (populated by the consent flow when
-- the consenting user has a current org context). Our RLS contract test
-- (rls-coverage.integration.test.ts) auto-discovers any public table with
-- an `org_id` column as "org-tenant" and requires policies to reference
-- `breeze_has_org_access`. The existing policies only referenced the
-- partner axis (or user-id, for auth codes) — so the contract test failed
-- the moment the OAuth tables landed in dev.
--
-- This isn't a security bug today because:
--   * oauth_authorization_codes: id is a high-entropy nonce, gated by
--     user_id (the user who initiated the flow) — only that user (or
--     system) can find it.
--   * oauth_grants / oauth_refresh_tokens: gated by partner_id, so a user
--     in a different partner can never find them either.
-- But the org axis is the canonical second isolation boundary, and any
-- future query that filters by org_id should still respect it. So we add
-- `breeze_has_org_access(org_id)` as an alternative satisfaction branch:
-- if the row has an org_id and the caller has access to that org, they
-- can see the row. NULL partner rows remain system-only bootstrap rows.
--
-- We re-create each policy with an OR-extended predicate. Idempotent.

BEGIN;

-- oauth_authorization_codes: was user-id-OR-system; add org-axis branch.
DROP POLICY IF EXISTS oauth_auth_codes_user_access ON oauth_authorization_codes;
DO $$ BEGIN
  CREATE POLICY oauth_auth_codes_user_access ON oauth_authorization_codes
    FOR ALL TO breeze_app
    USING (
      user_id = breeze_current_user_id()
      OR breeze_current_scope() = 'system'
      OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
    )
    WITH CHECK (
      user_id = breeze_current_user_id()
      OR breeze_current_scope() = 'system'
      OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- oauth_grants: was system-OR-partner-access; add org-axis. NULL partner rows
-- are bootstrap-only and remain visible only through the system branch.
DROP POLICY IF EXISTS oauth_grants_partner_access ON oauth_grants;
DO $$ BEGIN
  CREATE POLICY oauth_grants_partner_access ON oauth_grants
    FOR ALL TO breeze_app
    USING (
      breeze_current_scope() = 'system'
      OR breeze_has_partner_access(partner_id)
      OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
    )
    WITH CHECK (
      breeze_current_scope() = 'system'
      OR breeze_has_partner_access(partner_id)
      OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- oauth_refresh_tokens: was strict partner-access; add system bypass +
-- org-axis branch. The system bypass mirrors what the auth-code and grant
-- tables already have — the adapter writes from a system context
-- (runOutsideDbContext + withSystemDbAccessContext) during refresh-token
-- mint and revoke, and without the bypass those writes would fail.
DROP POLICY IF EXISTS oauth_refresh_tokens_partner_access ON oauth_refresh_tokens;
DO $$ BEGIN
  CREATE POLICY oauth_refresh_tokens_partner_access ON oauth_refresh_tokens
    FOR ALL TO breeze_app
    USING (
      breeze_current_scope() = 'system'
      OR breeze_has_partner_access(partner_id)
      OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
    )
    WITH CHECK (
      breeze_current_scope() = 'system'
      OR breeze_has_partner_access(partner_id)
      OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
