-- Per-org Google Workspace connection for the Breeze identity tools.
-- One connection per org (resolved by org_id). Holds the service-account
-- credentials for domain-wide delegation. UNLIKE delegant_m365_connections,
-- this table DOES store a secret: service_account_key is the full SA JSON,
-- encrypted at rest by the application layer via secretCrypto (the column holds
-- ciphertext, never plaintext). admin_email is the super-admin the SA
-- impersonates for Admin SDK calls; Gmail/Calendar ops impersonate the target
-- end user at call time (not stored).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded FK, DROP POLICY IF EXISTS
-- before CREATE. autoMigrate wraps each file in a transaction — no inner
-- BEGIN/COMMIT.
CREATE TABLE IF NOT EXISTS google_workspace_connections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_domain        VARCHAR(253) NOT NULL,
  admin_email            VARCHAR(320) NOT NULL,
  service_account_email  VARCHAR(320) NOT NULL,
  service_account_key    TEXT NOT NULL,
  status                 VARCHAR(32) NOT NULL DEFAULT 'active',
  created_by             UUID,
  last_verified_at       TIMESTAMP,
  created_at             TIMESTAMP NOT NULL DEFAULT now(),
  updated_at             TIMESTAMP NOT NULL DEFAULT now()
);

-- One Google Workspace connection per org.
CREATE UNIQUE INDEX IF NOT EXISTS google_workspace_connections_org_uniq
  ON google_workspace_connections (org_id);

-- org_id -> organizations(id) FK with ON DELETE CASCADE so connections can't
-- orphan and org teardown auto-cleans them. Guarded for DBs that created the
-- table before the FK existed; fresh creates above already carry it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_workspace_connections_org_id_fkey'
      AND conrelid = 'google_workspace_connections'::regclass
  ) THEN
    ALTER TABLE google_workspace_connections
      ADD CONSTRAINT google_workspace_connections_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Row-Level Security: per-org tenant data, mirroring delegant_m365_connections
-- and c2c_connections. Canonical breeze_org_isolation_{select,insert,update,
-- delete} backed by public.breeze_has_org_access(org_id). ENABLE + FORCE so even
-- the table owner is bound. Idempotent — safe to re-run.
DROP POLICY IF EXISTS breeze_org_isolation_select ON google_workspace_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON google_workspace_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON google_workspace_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON google_workspace_connections;

ALTER TABLE google_workspace_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_workspace_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON google_workspace_connections
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON google_workspace_connections
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON google_workspace_connections
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON google_workspace_connections
  FOR DELETE USING (public.breeze_has_org_access(org_id));
