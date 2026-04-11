-- 2026-04-11: Bucket C Phase 4 — session/execution cluster RLS.
--
-- Same shape as phases 1-3: denormalize org_id, backfill, NOT NULL,
-- plain FK, 4 standard breeze_org_isolation_* policies.
--
-- Tables:
--   - script_executions        (script runs on devices)
--   - remote_sessions          (remote desktop / terminal sessions)
--   - device_group_memberships (device → device_group junction)
--   - group_membership_log     (append-only change log for memberships)
--   - snmp_metrics             (SNMP poll results from background worker)
--
-- Fully idempotent.

BEGIN;

-- -------- script_executions --------
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE script_executions SET org_id = d.org_id FROM devices d
 WHERE d.id = script_executions.device_id AND script_executions.org_id IS NULL;
ALTER TABLE script_executions ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'script_executions_org_id_organizations_id_fk') THEN
    ALTER TABLE script_executions ADD CONSTRAINT script_executions_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON script_executions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_executions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_executions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_executions;
ALTER TABLE script_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON script_executions FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON script_executions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON script_executions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON script_executions FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- remote_sessions --------
ALTER TABLE remote_sessions ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE remote_sessions SET org_id = d.org_id FROM devices d
 WHERE d.id = remote_sessions.device_id AND remote_sessions.org_id IS NULL;
ALTER TABLE remote_sessions ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_sessions_org_id_organizations_id_fk') THEN
    ALTER TABLE remote_sessions ADD CONSTRAINT remote_sessions_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON remote_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON remote_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON remote_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON remote_sessions;
ALTER TABLE remote_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON remote_sessions FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON remote_sessions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON remote_sessions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON remote_sessions FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- device_group_memberships --------
ALTER TABLE device_group_memberships ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE device_group_memberships SET org_id = d.org_id FROM devices d
 WHERE d.id = device_group_memberships.device_id AND device_group_memberships.org_id IS NULL;
ALTER TABLE device_group_memberships ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_group_memberships_org_id_organizations_id_fk') THEN
    ALTER TABLE device_group_memberships ADD CONSTRAINT device_group_memberships_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_group_memberships;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_group_memberships;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_group_memberships;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_group_memberships;
ALTER TABLE device_group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_group_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON device_group_memberships FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_group_memberships FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_group_memberships FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_group_memberships FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- group_membership_log --------
ALTER TABLE group_membership_log ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE group_membership_log SET org_id = d.org_id FROM devices d
 WHERE d.id = group_membership_log.device_id AND group_membership_log.org_id IS NULL;
ALTER TABLE group_membership_log ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_membership_log_org_id_organizations_id_fk') THEN
    ALTER TABLE group_membership_log ADD CONSTRAINT group_membership_log_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON group_membership_log;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON group_membership_log;
DROP POLICY IF EXISTS breeze_org_isolation_update ON group_membership_log;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON group_membership_log;
ALTER TABLE group_membership_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_membership_log FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON group_membership_log FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON group_membership_log FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON group_membership_log FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON group_membership_log FOR DELETE USING (public.breeze_has_org_access(org_id));

-- -------- snmp_metrics --------
ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE snmp_metrics SET org_id = d.org_id FROM devices d
 WHERE d.id = snmp_metrics.device_id AND snmp_metrics.org_id IS NULL;
ALTER TABLE snmp_metrics ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snmp_metrics_org_id_organizations_id_fk') THEN
    ALTER TABLE snmp_metrics ADD CONSTRAINT snmp_metrics_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
END $$;
DROP POLICY IF EXISTS breeze_org_isolation_select ON snmp_metrics;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON snmp_metrics;
DROP POLICY IF EXISTS breeze_org_isolation_update ON snmp_metrics;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON snmp_metrics;
ALTER TABLE snmp_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE snmp_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_org_isolation_select ON snmp_metrics FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON snmp_metrics FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON snmp_metrics FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON snmp_metrics FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
