-- 2026-04-24: Persist OAuth Sessions and Grants in Postgres.
--
-- Until now, Session/Grant lived in a process-local Map in adapter.ts. That
-- means an API restart wipes every authenticated session and every consent
-- grant — in-flight OAuth flows die mid-redirect, and any access token whose
-- Grant we'd want to look up is silently orphaned. JWT access tokens are
-- self-validating and survive (10-min TTL anyway), but Grants are referenced
-- by the refresh_token grant handler at every refresh — so without
-- persistence, a refresh after restart fails with `invalid_grant`.
--
-- Sessions:
--   id text PK = oidc-provider's Session.jti (Session.id getter returns jti).
--   uid text indexed for Session.findByUid (called during token issuance to
--     confirm the authorizing session still exists).
--   account_id nullable — Sessions are created BEFORE login (anonymous, then
--     mutated with loginAccount(...)). Anonymous/bootstrap rows are only
--     visible to system scope; user scope can only see rows bound to that user.
--
-- Grants:
--   id text PK = Grant.jti.
--   partner_id/org_id are populated by the consent route (setGrantBreezeMeta
--     side-table is being deprecated in favor of these columns). The Grant
--     payload contains the standard oidc-provider fields (accountId, clientId,
--     resources, openid, rejected, rar) + our `breeze` blob inline (oidc-
--     provider's IN_PAYLOAD stripping is bypassed because we own the storage
--     here — we hand-write the Drizzle insert).
--   RLS: partner-axis with system-bypass so the adapter can write/read from
--     system context. NULL partner rows are bootstrap-only and system-scoped.
--
-- Idempotent. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_sessions (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  account_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  payload     JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_sessions_uid_idx        ON oauth_sessions(uid);
CREATE INDEX IF NOT EXISTS oauth_sessions_account_idx    ON oauth_sessions(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_sessions_expires_idx    ON oauth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id          TEXT PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  partner_id  UUID REFERENCES partners(id) ON DELETE CASCADE,
  org_id      UUID REFERENCES organizations(id) ON DELETE SET NULL,
  payload     JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_grants_account_idx ON oauth_grants(account_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx  ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS oauth_grants_partner_idx ON oauth_grants(partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_grants_expires_idx ON oauth_grants(expires_at);

ALTER TABLE oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants   FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY oauth_sessions_user_access ON oauth_sessions
    FOR ALL TO breeze_app
    USING (breeze_current_scope() = 'system' OR account_id = breeze_current_user_id())
    WITH CHECK (breeze_current_scope() = 'system' OR account_id = breeze_current_user_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY oauth_grants_partner_access ON oauth_grants
    FOR ALL TO breeze_app
    USING (
      breeze_current_scope() = 'system'
      OR breeze_has_partner_access(partner_id)
    )
    WITH CHECK (
      breeze_current_scope() = 'system'
      OR breeze_has_partner_access(partner_id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
