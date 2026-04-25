-- 2026-04-19: installer_bootstrap_tokens — single-use, short-TTL tokens for
-- the macOS GUI installer. Tokens are issued at installer-download time and
-- consumed by the unauthenticated /api/v1/installer/bootstrap/:token route.
--
-- RLS Shape 1 (direct org_id) — auto-discovered by the rls-coverage
-- integration test, no allowlist entry needed.
--
-- Fully idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS installer_bootstrap_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_enrollment_key_id UUID NOT NULL REFERENCES enrollment_keys(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id),
  max_usage INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_from_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_installer_bootstrap_tokens_expires
  ON installer_bootstrap_tokens(expires_at);

-- ============================================================
-- RLS — Shape 1, direct org_id, standard four breeze_org_isolation policies
-- ============================================================

ALTER TABLE installer_bootstrap_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE installer_bootstrap_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON installer_bootstrap_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON installer_bootstrap_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_update ON installer_bootstrap_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON installer_bootstrap_tokens;

CREATE POLICY breeze_org_isolation_select ON installer_bootstrap_tokens
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON installer_bootstrap_tokens
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON installer_bootstrap_tokens
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON installer_bootstrap_tokens
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
