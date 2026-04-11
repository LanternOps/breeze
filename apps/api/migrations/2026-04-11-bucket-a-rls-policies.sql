-- 2026-04-11: Enable RLS on 16 tables that were created after migration 0008's
-- auto-enable DO loop ran and therefore never received row-level security.
--
-- Every table listed here has an org_id NOT NULL column. The helper function
-- public.breeze_has_org_access(org_id) already handles system-scope tokens
-- (they short-circuit to true), so no additional clause is required.
--
-- The migration is fully idempotent: DROP POLICY IF EXISTS is a no-op when the
-- policy does not exist, and ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a
-- no-op when RLS is already enabled. Safe to re-run at any time.

BEGIN;

-- ============================================================
-- backup_jobs
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_jobs;

ALTER TABLE backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_jobs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_jobs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_jobs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_jobs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- backup_policies
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_policies;

ALTER TABLE backup_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_policies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_policies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_policies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_policies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- backup_snapshots
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshots;

ALTER TABLE backup_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_snapshots
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_snapshots
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_snapshots
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_snapshots
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- backup_verifications
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_verifications;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_verifications;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_verifications;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_verifications;

ALTER TABLE backup_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_verifications FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_verifications
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_verifications
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_verifications
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_verifications
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- c2c_consent_sessions
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON c2c_consent_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON c2c_consent_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON c2c_consent_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON c2c_consent_sessions;

ALTER TABLE c2c_consent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE c2c_consent_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON c2c_consent_sessions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON c2c_consent_sessions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON c2c_consent_sessions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON c2c_consent_sessions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- config_policy_backup_settings
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_backup_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_backup_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_backup_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_backup_settings;

ALTER TABLE config_policy_backup_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_backup_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON config_policy_backup_settings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON config_policy_backup_settings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON config_policy_backup_settings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON config_policy_backup_settings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- device_warranty
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_warranty;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_warranty;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_warranty;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_warranty;

ALTER TABLE device_warranty ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_warranty FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON device_warranty
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_warranty
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_warranty
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_warranty
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- notification_routing_rules
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON notification_routing_rules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON notification_routing_rules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON notification_routing_rules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON notification_routing_rules;

ALTER TABLE notification_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_routing_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON notification_routing_rules
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON notification_routing_rules
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON notification_routing_rules
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON notification_routing_rules
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- recovery_boot_media_artifacts
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON recovery_boot_media_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON recovery_boot_media_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON recovery_boot_media_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON recovery_boot_media_artifacts;

ALTER TABLE recovery_boot_media_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_boot_media_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON recovery_boot_media_artifacts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON recovery_boot_media_artifacts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON recovery_boot_media_artifacts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON recovery_boot_media_artifacts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- recovery_media_artifacts
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON recovery_media_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON recovery_media_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON recovery_media_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON recovery_media_artifacts;

ALTER TABLE recovery_media_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_media_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON recovery_media_artifacts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON recovery_media_artifacts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON recovery_media_artifacts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON recovery_media_artifacts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- recovery_readiness
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON recovery_readiness;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON recovery_readiness;
DROP POLICY IF EXISTS breeze_org_isolation_update ON recovery_readiness;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON recovery_readiness;

ALTER TABLE recovery_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_readiness FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON recovery_readiness
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON recovery_readiness
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON recovery_readiness
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON recovery_readiness
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- restore_jobs
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON restore_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON restore_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON restore_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON restore_jobs;

ALTER TABLE restore_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON restore_jobs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON restore_jobs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON restore_jobs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON restore_jobs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- service_process_check_results
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_process_check_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_process_check_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_process_check_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_process_check_results;

ALTER TABLE service_process_check_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_process_check_results FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON service_process_check_results
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_process_check_results
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_process_check_results
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_process_check_results
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- tunnel_allowlists
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON tunnel_allowlists;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON tunnel_allowlists;
DROP POLICY IF EXISTS breeze_org_isolation_update ON tunnel_allowlists;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON tunnel_allowlists;

ALTER TABLE tunnel_allowlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE tunnel_allowlists FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON tunnel_allowlists
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON tunnel_allowlists
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON tunnel_allowlists
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON tunnel_allowlists
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- tunnel_sessions
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON tunnel_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON tunnel_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON tunnel_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON tunnel_sessions;

ALTER TABLE tunnel_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tunnel_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON tunnel_sessions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON tunnel_sessions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON tunnel_sessions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON tunnel_sessions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- vault_snapshot_inventory
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON vault_snapshot_inventory;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON vault_snapshot_inventory;
DROP POLICY IF EXISTS breeze_org_isolation_update ON vault_snapshot_inventory;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON vault_snapshot_inventory;

ALTER TABLE vault_snapshot_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_snapshot_inventory FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON vault_snapshot_inventory
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON vault_snapshot_inventory
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON vault_snapshot_inventory
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON vault_snapshot_inventory
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
