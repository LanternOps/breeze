-- 2026-07-08: Per-device automation run results (#2023).
--
-- automation_runs stores only per-RUN aggregate counters + a jsonb log blob.
-- This adds a structured child table with one row per targeted device per run,
-- giving the consolidated per-device pass/fail/pending breakdown + timing +
-- output that the "detailed automation execution history with live progress"
-- feature needs. The runtime seeds a 'pending' row per device up front and
-- updates each to running → success/failed as the concurrency loop finishes,
-- so a polling UI can watch live progress.
--
-- Tenancy (Shape 1, direct org_id): org_id is DENORMALIZED to the DEVICE's org,
-- not the automation's. A partner-wide automation (automations.org_id NULL,
-- #2133) has no org of its own, so — like every other worker-created child row
-- (software_deployments, alerts) — these results take the device's org. That
-- makes the table auto-discovered by the RLS coverage contract test with a
-- plain breeze_has_org_access(org_id) policy; no allowlist entry is needed.
--
-- Idempotent: enum guarded by pg_type check, CREATE TABLE/INDEX IF NOT EXISTS,
-- DROP POLICY IF EXISTS before each CREATE. autoMigrate wraps the file in a
-- transaction — no inner BEGIN/COMMIT.

-- Enum: per-device outcome.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_device_result_status') THEN
    CREATE TYPE automation_device_result_status AS ENUM ('pending', 'running', 'success', 'failed', 'skipped');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS automation_run_device_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  status automation_device_result_status NOT NULL DEFAULT 'pending',
  started_at timestamp,
  completed_at timestamp,
  output text,
  error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ardr_run_id_idx ON automation_run_device_results(run_id);
CREATE INDEX IF NOT EXISTS ardr_device_id_idx ON automation_run_device_results(device_id);
CREATE INDEX IF NOT EXISTS ardr_org_id_idx ON automation_run_device_results(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ardr_run_device_unique ON automation_run_device_results(run_id, device_id);

-- RLS: direct org_id (Shape 1) — standard org isolation on the device's org.
ALTER TABLE automation_run_device_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_run_device_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON automation_run_device_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON automation_run_device_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON automation_run_device_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON automation_run_device_results;

CREATE POLICY breeze_org_isolation_select ON automation_run_device_results FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON automation_run_device_results FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON automation_run_device_results FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON automation_run_device_results FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);
