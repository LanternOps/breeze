-- Tenant-scoped extension installs (L1). One row per (extension, org)
-- activation. This is an AUTHORIZATION record, not a deployment fact: one
-- bundle server-wide, activated per org. The gateway install gate and the job
-- hosts read this table in SYSTEM scope (the caller's own row visibility must
-- not decide an authorization question); the partner management API reads and
-- writes it in the caller's scope, bounded by the org-axis RLS below. Both
-- paths are served by breeze_has_org_access(org_id), whose system-scope branch
-- returns TRUE (0008-tenant-rls.sql).
--
-- org_id carries no FK to organizations: org deletion is handled by the
-- tenant cascade (CORE_ORG_CASCADE_DELETE_ORDER in services/tenantCascade.ts),
-- like every other org-axis table. extension removal cascades via the FK.

CREATE TABLE IF NOT EXISTS extension_org_installs (
  extension_name text NOT NULL REFERENCES installed_extensions(name) ON DELETE CASCADE,
  org_id         uuid NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  installed_by   uuid,
  installed_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_name, org_id)
);

CREATE INDEX IF NOT EXISTS extension_org_installs_org_idx ON extension_org_installs(org_id);

ALTER TABLE extension_org_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_org_installs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS extension_org_installs_select ON extension_org_installs;
CREATE POLICY extension_org_installs_select ON extension_org_installs FOR SELECT USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS extension_org_installs_insert ON extension_org_installs;
CREATE POLICY extension_org_installs_insert ON extension_org_installs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS extension_org_installs_update ON extension_org_installs;
CREATE POLICY extension_org_installs_update ON extension_org_installs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS extension_org_installs_delete ON extension_org_installs;
CREATE POLICY extension_org_installs_delete ON extension_org_installs FOR DELETE USING (public.breeze_has_org_access(org_id));
