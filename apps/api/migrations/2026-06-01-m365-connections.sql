-- Per-org Microsoft 365 connection for the Breeze identity tools.
-- One connection per org (resolved by org_id). Holds the Azure AD app-registration
-- credentials for a client-credentials Graph flow: tenant_id + client_id identify
-- the app; client_secret is the app secret, encrypted at rest by the application
-- layer via secretCrypto (the column holds ciphertext, never plaintext).
-- Distinct from delegant_m365_connections (no secret) and c2c_connections (backup).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded FK, DROP POLICY IF EXISTS
-- before CREATE. autoMigrate wraps each file in a transaction — no inner
-- BEGIN/COMMIT.
CREATE TABLE IF NOT EXISTS m365_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id         VARCHAR(64) NOT NULL,
  client_id         VARCHAR(64) NOT NULL,
  client_secret     TEXT NOT NULL,
  display_name      VARCHAR(256),
  status            VARCHAR(32) NOT NULL DEFAULT 'active',
  created_by        UUID,
  last_verified_at  TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- One Microsoft 365 connection per org.
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_org_uniq
  ON m365_connections (org_id);

-- org_id -> organizations(id) FK with ON DELETE CASCADE so connections can't
-- orphan and org teardown auto-cleans them. Guarded for DBs that created the
-- table before the FK existed; fresh creates above already carry it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_connections_org_id_fkey'
      AND conrelid = 'm365_connections'::regclass
  ) THEN
    ALTER TABLE m365_connections
      ADD CONSTRAINT m365_connections_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Row-Level Security: per-org tenant data, mirroring google_workspace_connections
-- and delegant_m365_connections. Canonical breeze_org_isolation_{select,insert,
-- update,delete} backed by public.breeze_has_org_access(org_id). ENABLE + FORCE
-- so even the table owner is bound. Idempotent — safe to re-run.
DROP POLICY IF EXISTS breeze_org_isolation_select ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON m365_connections;

ALTER TABLE m365_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON m365_connections
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON m365_connections
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON m365_connections
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON m365_connections
  FOR DELETE USING (public.breeze_has_org_access(org_id));
