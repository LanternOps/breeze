-- 2026-04-11: Bucket C Phase 3 — device state + filesystem cluster RLS.
--
-- Same shape as phases 1 and 2: denormalize org_id, backfill, NOT NULL,
-- plain FK, 4 standard breeze_org_isolation_* policies.
--
-- Tables:
--   - device_registry_state        (Windows registry collection state)
--   - device_config_state          (config/file collection state)
--   - device_filesystem_scan_state (filesystem analysis scan state)
--   - device_filesystem_snapshots  (filesystem snapshot records)
--   - device_filesystem_cleanup_runs (filesystem cleanup run records)
--
-- Write sites updated in the same commit:
--   - routes/agents/state.ts (registry + config state PUT handlers)
--   - services/filesystemAnalysis.ts (filesystem scan/snapshot upserts)
--   - services/aiToolsFilesystem.ts / routes/devices/filesystem.ts
--     (cleanup run inserts)
--
-- Fully idempotent.

BEGIN;

-- -------- device_registry_state --------
ALTER TABLE device_registry_state ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_registry_state SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_registry_state.device_id AND device_registry_state.org_id IS NULL;
ALTER TABLE device_registry_state ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_registry_state_org_id_organizations_id_fk') THEN
    ALTER TABLE device_registry_state ADD CONSTRAINT device_registry_state_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_registry_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_registry_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_registry_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_registry_state;
ALTER TABLE device_registry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_registry_state FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_registry_state FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_registry_state FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_registry_state FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_registry_state FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_config_state --------
ALTER TABLE device_config_state ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_config_state SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_config_state.device_id AND device_config_state.org_id IS NULL;
ALTER TABLE device_config_state ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_config_state_org_id_organizations_id_fk') THEN
    ALTER TABLE device_config_state ADD CONSTRAINT device_config_state_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_config_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_config_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_config_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_config_state;
ALTER TABLE device_config_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_config_state FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_config_state FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_config_state FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_config_state FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_config_state FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_filesystem_scan_state --------
ALTER TABLE device_filesystem_scan_state ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_filesystem_scan_state SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_filesystem_scan_state.device_id AND device_filesystem_scan_state.org_id IS NULL;
ALTER TABLE device_filesystem_scan_state ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_filesystem_scan_state_org_id_organizations_id_fk') THEN
    ALTER TABLE device_filesystem_scan_state ADD CONSTRAINT device_filesystem_scan_state_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_filesystem_scan_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_filesystem_scan_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_filesystem_scan_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_filesystem_scan_state;
ALTER TABLE device_filesystem_scan_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_filesystem_scan_state FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_filesystem_scan_state FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_filesystem_scan_state FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_filesystem_scan_state FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_filesystem_scan_state FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_filesystem_snapshots --------
ALTER TABLE device_filesystem_snapshots ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_filesystem_snapshots SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_filesystem_snapshots.device_id AND device_filesystem_snapshots.org_id IS NULL;
ALTER TABLE device_filesystem_snapshots ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_filesystem_snapshots_org_id_organizations_id_fk') THEN
    ALTER TABLE device_filesystem_snapshots ADD CONSTRAINT device_filesystem_snapshots_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_filesystem_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_filesystem_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_filesystem_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_filesystem_snapshots;
ALTER TABLE device_filesystem_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_filesystem_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_filesystem_snapshots FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_filesystem_snapshots FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_filesystem_snapshots FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_filesystem_snapshots FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_filesystem_cleanup_runs --------
ALTER TABLE device_filesystem_cleanup_runs ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_filesystem_cleanup_runs SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_filesystem_cleanup_runs.device_id AND device_filesystem_cleanup_runs.org_id IS NULL;
ALTER TABLE device_filesystem_cleanup_runs ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_filesystem_cleanup_runs_org_id_organizations_id_fk') THEN
    ALTER TABLE device_filesystem_cleanup_runs ADD CONSTRAINT device_filesystem_cleanup_runs_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_filesystem_cleanup_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_filesystem_cleanup_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_filesystem_cleanup_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_filesystem_cleanup_runs;
ALTER TABLE device_filesystem_cleanup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_filesystem_cleanup_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_filesystem_cleanup_runs FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_filesystem_cleanup_runs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_filesystem_cleanup_runs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_filesystem_cleanup_runs FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
