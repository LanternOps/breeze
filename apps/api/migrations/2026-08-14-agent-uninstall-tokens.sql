-- 2026-08-14: agent_uninstall_tokens — single-use, short-TTL authorization
-- tokens for LOCAL agent uninstall.
--
-- Why: GET /api/v1/agents/uninstall.sh used to be unauthenticated and tore the
-- agent off any machine it was run on, so any local admin could strip a managed
-- client. A local uninstall now has to present a token minted by the RMM
-- (POST /devices/:id/uninstall-token, DEVICES_DELETE + MFA) which the agent
-- exchanges at POST /agents/:id/uninstall-authorize before it will tear down.
--
-- Tenancy: RLS Shape 1 (direct org_id). The table ALSO carries device_id, but
-- CLAUDE.md's Shape 5 "Device-id scoped" row only applies to tables with NO
-- denormalized org_id (those use the EXISTS-join policy and are listed in
-- DEVICE_ID_JOIN_POLICY_TABLES). This table denormalizes org_id — it is a hot,
-- agent-read path where an EXISTS join through devices would be evaluated per
-- row — so it takes the standard breeze_has_org_access(org_id) policies and is
-- auto-discovered by the rls-coverage integration test (no allowlist entry).
-- It is registered in the org cascade, both device cascade lists, and the
-- tenant export policy in the same change.
--
-- `token` stores the PEPPERED SHA-256 (services/enrollmentKeySecurity.ts
-- hashEnrollmentKey), never the plaintext — same at-rest treatment as
-- enrollment_keys.key. The plaintext is returned exactly once, at mint time.
--
-- Fully idempotent — safe to re-run. No inner BEGIN;/COMMIT; (autoMigrate
-- wraps each file in its own transaction).

CREATE TABLE IF NOT EXISTS agent_uninstall_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- Peppered SHA-256 of the plaintext token. UNIQUE so a burn can be a single
  -- atomic UPDATE keyed on the hash.
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_from_ip TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Expiry must be strictly after issue: a token that is born expired is a
-- clock/caller bug, not a valid row.
DO $$
BEGIN
  ALTER TABLE agent_uninstall_tokens
    DROP CONSTRAINT IF EXISTS agent_uninstall_tokens_expires_after_created;
  ALTER TABLE agent_uninstall_tokens
    ADD CONSTRAINT agent_uninstall_tokens_expires_after_created
    CHECK (expires_at > created_at);
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_uninstall_tokens_device
  ON agent_uninstall_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_agent_uninstall_tokens_org
  ON agent_uninstall_tokens(org_id);
-- Serves the nightly expiry cleanup.
CREATE INDEX IF NOT EXISTS idx_agent_uninstall_tokens_expires
  ON agent_uninstall_tokens(expires_at);

-- ============================================================
-- RLS — Shape 1, direct org_id, standard four breeze_org_isolation policies
-- ============================================================

ALTER TABLE agent_uninstall_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_uninstall_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON agent_uninstall_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON agent_uninstall_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_update ON agent_uninstall_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON agent_uninstall_tokens;

CREATE POLICY breeze_org_isolation_select ON agent_uninstall_tokens
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON agent_uninstall_tokens
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON agent_uninstall_tokens
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON agent_uninstall_tokens
  FOR DELETE USING (public.breeze_has_org_access(org_id));
