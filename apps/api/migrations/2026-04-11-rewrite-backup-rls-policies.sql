-- 2026-04-11: Rewrite broken backup / DR / C2C / vault RLS policies.
--
-- Security review found that migrations 0077, 0081, and 0082 installed RLS
-- policies that reference the non-existent session variable
-- `app.current_org_id`. The application sets `breeze.scope` and
-- `breeze.accessible_org_ids` via withDbAccessContext() and never touches
-- `app.current_org_id`, so these policies deny all access once the BYPASSRLS
-- workaround is removed from the DB role. Additionally, several of these
-- tables only had ENABLE ROW LEVEL SECURITY (not FORCE), so the table owner
-- still bypassed the policy entirely.
--
-- This migration drops the broken policies and replaces them with the
-- standard breeze_org_isolation_{select,insert,update,delete} pattern backed
-- by public.breeze_has_org_access(org_id) (see migration 0008). Fully
-- idempotent — safe to re-run.

BEGIN;

-- ============================================================
-- sql_instances (from 0077)
-- ============================================================
DROP POLICY IF EXISTS sql_instances_org_isolation ON sql_instances;
DROP POLICY IF EXISTS "org_isolation" ON sql_instances;
DROP POLICY IF EXISTS breeze_org_isolation_select ON sql_instances;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON sql_instances;
DROP POLICY IF EXISTS breeze_org_isolation_update ON sql_instances;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON sql_instances;

ALTER TABLE sql_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE sql_instances FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON sql_instances
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON sql_instances
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON sql_instances
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON sql_instances
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- backup_chains (from 0077)
-- ============================================================
DROP POLICY IF EXISTS backup_chains_org_isolation ON backup_chains;
DROP POLICY IF EXISTS "org_isolation" ON backup_chains;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_chains;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_chains;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_chains;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_chains;

ALTER TABLE backup_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_chains FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_chains
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_chains
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_chains
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_chains
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- storage_encryption_keys (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON storage_encryption_keys;
DROP POLICY IF EXISTS breeze_org_isolation_select ON storage_encryption_keys;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON storage_encryption_keys;
DROP POLICY IF EXISTS breeze_org_isolation_update ON storage_encryption_keys;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON storage_encryption_keys;

ALTER TABLE storage_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_encryption_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON storage_encryption_keys
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON storage_encryption_keys
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON storage_encryption_keys
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON storage_encryption_keys
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- recovery_tokens (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON recovery_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_select ON recovery_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON recovery_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_update ON recovery_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON recovery_tokens;

ALTER TABLE recovery_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON recovery_tokens
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON recovery_tokens
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON recovery_tokens
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON recovery_tokens
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- hyperv_vms (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON hyperv_vms;
DROP POLICY IF EXISTS breeze_org_isolation_select ON hyperv_vms;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON hyperv_vms;
DROP POLICY IF EXISTS breeze_org_isolation_update ON hyperv_vms;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON hyperv_vms;

ALTER TABLE hyperv_vms ENABLE ROW LEVEL SECURITY;
ALTER TABLE hyperv_vms FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON hyperv_vms
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON hyperv_vms
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON hyperv_vms
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON hyperv_vms
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- c2c_connections (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON c2c_connections;
DROP POLICY IF EXISTS breeze_org_isolation_select ON c2c_connections;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON c2c_connections;
DROP POLICY IF EXISTS breeze_org_isolation_update ON c2c_connections;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON c2c_connections;

ALTER TABLE c2c_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE c2c_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON c2c_connections
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON c2c_connections
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON c2c_connections
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON c2c_connections
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- c2c_backup_configs (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON c2c_backup_configs;
DROP POLICY IF EXISTS breeze_org_isolation_select ON c2c_backup_configs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON c2c_backup_configs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON c2c_backup_configs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON c2c_backup_configs;

ALTER TABLE c2c_backup_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE c2c_backup_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON c2c_backup_configs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON c2c_backup_configs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON c2c_backup_configs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON c2c_backup_configs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- c2c_backup_jobs (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON c2c_backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_select ON c2c_backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON c2c_backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON c2c_backup_jobs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON c2c_backup_jobs;

ALTER TABLE c2c_backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE c2c_backup_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON c2c_backup_jobs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON c2c_backup_jobs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON c2c_backup_jobs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON c2c_backup_jobs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- c2c_backup_items (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON c2c_backup_items;
DROP POLICY IF EXISTS breeze_org_isolation_select ON c2c_backup_items;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON c2c_backup_items;
DROP POLICY IF EXISTS breeze_org_isolation_update ON c2c_backup_items;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON c2c_backup_items;

ALTER TABLE c2c_backup_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE c2c_backup_items FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON c2c_backup_items
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON c2c_backup_items
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON c2c_backup_items
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON c2c_backup_items
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- backup_sla_configs (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON backup_sla_configs;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_sla_configs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_sla_configs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_sla_configs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_sla_configs;

ALTER TABLE backup_sla_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_sla_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_sla_configs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_sla_configs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_sla_configs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_sla_configs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- backup_sla_events (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON backup_sla_events;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_sla_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_sla_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_sla_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_sla_events;

ALTER TABLE backup_sla_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_sla_events FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_sla_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_sla_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_sla_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_sla_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- dr_plans (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON dr_plans;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dr_plans;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dr_plans;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dr_plans;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dr_plans;

ALTER TABLE dr_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE dr_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON dr_plans
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dr_plans
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dr_plans
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dr_plans
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- dr_plan_groups (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON dr_plan_groups;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dr_plan_groups;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dr_plan_groups;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dr_plan_groups;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dr_plan_groups;

ALTER TABLE dr_plan_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE dr_plan_groups FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON dr_plan_groups
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dr_plan_groups
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dr_plan_groups
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dr_plan_groups
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- dr_executions (from 0081)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON dr_executions;
DROP POLICY IF EXISTS breeze_org_isolation_select ON dr_executions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON dr_executions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON dr_executions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON dr_executions;

ALTER TABLE dr_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dr_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON dr_executions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON dr_executions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON dr_executions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON dr_executions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- local_vaults (from 0082)
-- ============================================================
DROP POLICY IF EXISTS "org_isolation" ON local_vaults;
DROP POLICY IF EXISTS breeze_org_isolation_select ON local_vaults;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON local_vaults;
DROP POLICY IF EXISTS breeze_org_isolation_update ON local_vaults;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON local_vaults;

ALTER TABLE local_vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_vaults FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON local_vaults
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON local_vaults
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON local_vaults
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON local_vaults
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
