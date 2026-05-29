-- Per-customer M365 connection pointers for the Breeze AI agent's Delegant
-- integration. Stores references into Delegant + display metadata only.
-- NO secrets here: the per-customer Entra client secret lives in Delegant.
CREATE TABLE IF NOT EXISTS delegant_m365_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL,
  customer_label        VARCHAR(128) NOT NULL,
  customer_display_name VARCHAR(256) NOT NULL,
  delegant_org_id       VARCHAR(64) NOT NULL,
  delegant_connection_id VARCHAR(64) NOT NULL,
  m365_tenant_id        VARCHAR(64) NOT NULL,
  status                VARCHAR(32) NOT NULL DEFAULT 'active',
  last_verified_at      TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS delegant_m365_org_customer_uniq
  ON delegant_m365_connections (org_id, customer_label);
CREATE INDEX IF NOT EXISTS delegant_m365_org_idx
  ON delegant_m365_connections (org_id);

-- Row-Level Security: this is per-org tenant data, mirroring c2c_connections.
-- Use the canonical breeze_org_isolation_{select,insert,update,delete} pattern
-- backed by public.breeze_has_org_access(org_id) (see migration 0008 and the
-- 2026-04-11 RLS rewrite). ENABLE + FORCE so even the table owner is bound.
-- Idempotent — safe to re-run.
DROP POLICY IF EXISTS breeze_org_isolation_select ON delegant_m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON delegant_m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON delegant_m365_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON delegant_m365_connections;

ALTER TABLE delegant_m365_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegant_m365_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON delegant_m365_connections
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON delegant_m365_connections
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON delegant_m365_connections
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON delegant_m365_connections
  FOR DELETE USING (public.breeze_has_org_access(org_id));
