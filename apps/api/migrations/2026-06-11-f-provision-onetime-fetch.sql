-- 2026-06-11: provision_credential_handles — short-TTL, single-use handles for
-- the device-provision credential blob. Closes #917 L-3.
--
-- Background: POST /devices/provision previously returned the agent's
-- long-lived secrets (auth_token, watchdog_auth_token, helper_auth_token,
-- mtls.private_key) inline in the JSON body with no TTL. If the admin UI
-- logged or persisted the response before transport, those long-lived
-- secrets sat in plaintext.
--
-- Fix: provision now stores the credential blob server-side keyed by an
-- unguessable token with a short TTL (default 5 min) and returns a one-time
-- fetch URL. The blob is delivered exactly once via
-- GET /devices/provision/fetch/:token and the handle is atomically marked
-- consumed. A second fetch, or a fetch after expiry, 404/410s.
--
-- The blob column holds the same secrets transiently; the row is single-use
-- and short-lived (minutes), and is hard-deleted on consume so plaintext
-- secrets do not linger at rest. A periodic sweep / the next provision can
-- also clean expired rows.
--
-- RLS Shape 1 (direct org_id) — auto-discovered by the rls-coverage
-- integration test, no allowlist entry needed.
--
-- Fully idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS provision_credential_handles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- The full agent config blob (includes plaintext secrets). Transient:
  -- single-use, short-TTL, deleted on consume.
  credentials JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_from_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_provision_credential_handles_expires
  ON provision_credential_handles(expires_at);

-- expires_at must be strictly after created_at
ALTER TABLE provision_credential_handles
  DROP CONSTRAINT IF EXISTS provision_credential_handles_expires_after_created;
ALTER TABLE provision_credential_handles
  ADD CONSTRAINT provision_credential_handles_expires_after_created
  CHECK (expires_at > created_at);

-- ============================================================
-- RLS — Shape 1, direct org_id, standard four breeze_org_isolation policies
-- ============================================================

ALTER TABLE provision_credential_handles ENABLE ROW LEVEL SECURITY;
ALTER TABLE provision_credential_handles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON provision_credential_handles;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON provision_credential_handles;
DROP POLICY IF EXISTS breeze_org_isolation_update ON provision_credential_handles;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON provision_credential_handles;

CREATE POLICY breeze_org_isolation_select ON provision_credential_handles
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON provision_credential_handles
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON provision_credential_handles
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON provision_credential_handles
  FOR DELETE USING (public.breeze_has_org_access(org_id));
