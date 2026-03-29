-- 0081: Add missing RLS policies for enterprise backup tables.
-- Idempotent: safe to re-run.

-- ── storage_encryption_keys ────────────────────────────────────────────────

ALTER TABLE "storage_encryption_keys" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "storage_encryption_keys"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── recovery_tokens ────────────────────────────────────────────────────────

ALTER TABLE "recovery_tokens" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "recovery_tokens"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── hyperv_vms ─────────────────────────────────────────────────────────────

ALTER TABLE "hyperv_vms" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "hyperv_vms"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── c2c_connections ────────────────────────────────────────────────────────

ALTER TABLE "c2c_connections" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "c2c_connections"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── c2c_backup_configs ─────────────────────────────────────────────────────

ALTER TABLE "c2c_backup_configs" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "c2c_backup_configs"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── c2c_backup_jobs ────────────────────────────────────────────────────────

ALTER TABLE "c2c_backup_jobs" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "c2c_backup_jobs"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── c2c_backup_items ───────────────────────────────────────────────────────

ALTER TABLE "c2c_backup_items" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "c2c_backup_items"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── backup_sla_configs ─────────────────────────────────────────────────────

ALTER TABLE "backup_sla_configs" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "backup_sla_configs"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── backup_sla_events ──────────────────────────────────────────────────────

ALTER TABLE "backup_sla_events" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "backup_sla_events"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── dr_plans ───────────────────────────────────────────────────────────────

ALTER TABLE "dr_plans" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "dr_plans"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── dr_plan_groups ─────────────────────────────────────────────────────────

ALTER TABLE "dr_plan_groups" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "dr_plan_groups"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── dr_executions ──────────────────────────────────────────────────────────

ALTER TABLE "dr_executions" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "dr_executions"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
