-- 2026-04-11: Bucket C Phase 2 — security/patch cluster RLS.
--
-- Same shape as Phase 1: denormalize org_id from devices, backfill,
-- plain FK, standard four-policy RLS. Covers the four tables written
-- from security command result handlers and the patch report endpoint:
--
--   - device_patches    (device_id + patch_id composite unique;
--                        upserted on every patch report / install)
--   - security_status   (one row per (device_id, provider), upserted on
--                        every security status report)
--   - security_scans    (append-only record of scan runs)
--   - security_threats  (append-only record of detected threats; also
--                        updated when threats are quarantined/removed)
--
-- Write sites (updated in the same commit):
--   - apps/api/src/routes/agents/patches.ts
--   - apps/api/src/routes/agents/helpers.ts (upsertSecurityStatusForDevice,
--     handleSecurityCommandResult)
--
-- Fully idempotent.

BEGIN;

-- -------- device_patches --------
ALTER TABLE device_patches ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_patches SET org_id = d.org_id
  FROM devices d
 WHERE d.id = device_patches.device_id
   AND device_patches.org_id IS NULL;
ALTER TABLE device_patches ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_patches_org_id_organizations_id_fk') THEN
    ALTER TABLE device_patches ADD CONSTRAINT device_patches_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_patches;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_patches;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_patches;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_patches;
ALTER TABLE device_patches ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_patches FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_patches
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_patches
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_patches
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_patches
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- security_status --------
ALTER TABLE security_status ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE security_status SET org_id = d.org_id
  FROM devices d
 WHERE d.id = security_status.device_id
   AND security_status.org_id IS NULL;
ALTER TABLE security_status ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'security_status_org_id_organizations_id_fk') THEN
    ALTER TABLE security_status ADD CONSTRAINT security_status_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON security_status;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON security_status;
DROP POLICY IF EXISTS breeze_org_isolation_update ON security_status;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON security_status;
ALTER TABLE security_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_status FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON security_status
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON security_status
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON security_status
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON security_status
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- security_scans --------
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE security_scans SET org_id = d.org_id
  FROM devices d
 WHERE d.id = security_scans.device_id
   AND security_scans.org_id IS NULL;
ALTER TABLE security_scans ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'security_scans_org_id_organizations_id_fk') THEN
    ALTER TABLE security_scans ADD CONSTRAINT security_scans_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON security_scans;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON security_scans;
DROP POLICY IF EXISTS breeze_org_isolation_update ON security_scans;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON security_scans;
ALTER TABLE security_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON security_scans
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON security_scans
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON security_scans
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON security_scans
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- security_threats --------
ALTER TABLE security_threats ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE security_threats SET org_id = d.org_id
  FROM devices d
 WHERE d.id = security_threats.device_id
   AND security_threats.org_id IS NULL;
ALTER TABLE security_threats ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'security_threats_org_id_organizations_id_fk') THEN
    ALTER TABLE security_threats ADD CONSTRAINT security_threats_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;

DROP POLICY IF EXISTS breeze_org_isolation_select ON security_threats;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON security_threats;
DROP POLICY IF EXISTS breeze_org_isolation_update ON security_threats;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON security_threats;
ALTER TABLE security_threats ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_threats FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON security_threats
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON security_threats
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON security_threats
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON security_threats
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
