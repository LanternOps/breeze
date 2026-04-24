-- 2026-04-24: Persist OAuth Interactions in Postgres.
--
-- Until now, the Interaction model fell into the in-memory Map fallback in
-- adapter.ts. Interactions are the short-lived (~1 hour) OAuth records that
-- bridge the /authorize redirect, the consent UI, and the post-consent
-- resume. If the API restarts mid-flow, the user sees a 404
-- "interaction expired or mismatched" the moment they click Approve — a
-- production bug, since deploys are routine and consent screens often sit
-- open while the user is reading scope text.
--
-- Schema:
--   id text PK = oidc-provider's Interaction.jti.
--   payload jsonb carries the full Interaction state, including the Session
--     binding once one is established (`payload->>'session'->>'accountId'`
--     populates after the user logs in).
--   expires_at — required by oidc-provider; always populated via the model's
--     1-hour TTL.
--
-- RLS: user-scope OR system-scope. Mirrors oauth_sessions / oauth_authorization_codes:
--   - The adapter writes from a system context (runOutsideDbContext +
--     withSystemDbAccessContext), so any policy that didn't include a system
--     bypass would 500 every interaction.save().
--   - During the consent UI's resume request, the user is authenticated and
--     we want the row visible under their request scope too — we accept
--     either (payload->'session'->>'accountId')::uuid = breeze_current_user_id()
--     (matches once the session has loginAccount'd) OR a system bypass.
--   - Pre-login interactions have no accountId set; the system-scope branch
--     covers those, identical to oauth_sessions.account_id NULL handling.
--
-- The interaction id is itself a high-entropy random nonce (oidc-provider
-- mints ~43-char URL-safe strings), so id-only lookups don't leak across
-- users; the payload accountId column remains the canonical tenancy axis
-- when accessed under a user scope.
--
-- Idempotent. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_interactions (
  id          TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_interactions_expires_idx ON oauth_interactions(expires_at);

ALTER TABLE oauth_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_interactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oauth_interactions_user_access ON oauth_interactions;

DO $$ BEGIN
  CREATE POLICY oauth_interactions_user_access ON oauth_interactions
    FOR ALL TO breeze_app
    USING (
      breeze_current_scope() = 'system'
      OR (
        breeze_current_user_id() IS NOT NULL
        AND (payload #>> '{session,accountId}')::uuid = breeze_current_user_id()
      )
    )
    WITH CHECK (
      breeze_current_scope() = 'system'
      OR (
        breeze_current_user_id() IS NOT NULL
        AND (payload #>> '{session,accountId}')::uuid = breeze_current_user_id()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
