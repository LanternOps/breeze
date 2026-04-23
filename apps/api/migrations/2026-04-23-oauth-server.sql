BEGIN;

-- oauth_clients: registered DCR clients, partner-scoped.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY, -- client_id (oidc-provider generates)
  partner_id UUID REFERENCES partners(id) ON DELETE CASCADE,
  -- partner_id is NULL for clients that register BEFORE the end-user picks a
  -- tenant in consent. It is UPDATEd to the chosen partner on first successful
  -- consent. Clients tied to a partner are visible/revocable from that
  -- partner's connected-apps dashboard.
  client_secret_hash TEXT, -- NULL for public clients (PKCE only)
  metadata JSONB NOT NULL, -- full RFC 7591 client metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_clients_partner_idx ON oauth_clients(partner_id) WHERE partner_id IS NOT NULL;

-- oauth_authorization_codes: short-lived (10min TTL) codes between authorize + token.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id TEXT PRIMARY KEY, -- the code value itself (opaque)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  payload JSONB NOT NULL, -- oidc-provider's internal payload blob
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_auth_codes_user_idx ON oauth_authorization_codes(user_id);
CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx ON oauth_authorization_codes(expires_at);

-- oauth_refresh_tokens: 60-day rolling, partner-scoped, revocable.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY, -- opaque token value
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx ON oauth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_partner_idx ON oauth_refresh_tokens(partner_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_idx ON oauth_refresh_tokens(client_id);

-- RLS: partner-axis for clients and refresh tokens; user-axis for auth codes.
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY oauth_clients_partner_access ON oauth_clients
    FOR ALL TO breeze_app
    USING (partner_id IS NULL OR breeze_has_partner_access(partner_id))
    WITH CHECK (partner_id IS NULL OR breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY oauth_auth_codes_user_access ON oauth_authorization_codes
    FOR ALL TO breeze_app
    USING (user_id = breeze_current_user_id())
    WITH CHECK (user_id = breeze_current_user_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY oauth_refresh_tokens_partner_access ON oauth_refresh_tokens
    FOR ALL TO breeze_app
    USING (breeze_has_partner_access(partner_id))
    WITH CHECK (breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
