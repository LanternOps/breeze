-- Durable per-action execution truth for automation runs. A queued command is
-- not completion; this table binds each normalized action to its asynchronous
-- result sources and records guarded, monotonic state.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_action_result_status') THEN
    CREATE TYPE automation_action_result_status AS ENUM (
      'pending', 'queued', 'delivered', 'running',
      'succeeded', 'failed', 'skipped', 'timed_out', 'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_action_terminal_source') THEN
    CREATE TYPE automation_action_terminal_source AS ENUM (
      'command', 'script_execution', 'deployment_result', 'timeout',
      'cancellation', 'reaper', 'dispatch'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS automation_action_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_index integer NOT NULL,
  action_type varchar(64) NOT NULL,
  status automation_action_result_status NOT NULL DEFAULT 'pending',
  terminal_source automation_action_terminal_source,
  command_id uuid,
  script_execution_id uuid,
  deployment_result_id uuid,
  message text,
  output text,
  error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_action_results_action_index_chk CHECK (action_index >= 0),
  CONSTRAINT automation_action_results_device_org_fkey
    FOREIGN KEY (device_id, org_id)
    REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_run_device_action_uq
  ON automation_action_results(run_id, device_id, action_index);
CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_command_uq
  ON automation_action_results(command_id) WHERE command_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_script_execution_uq
  ON automation_action_results(script_execution_id) WHERE script_execution_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_deployment_result_uq
  ON automation_action_results(deployment_result_id) WHERE deployment_result_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_action_results_run_idx
  ON automation_action_results(run_id);
CREATE INDEX IF NOT EXISTS automation_action_results_device_idx
  ON automation_action_results(device_id);
CREATE INDEX IF NOT EXISTS automation_action_results_org_idx
  ON automation_action_results(org_id);
CREATE INDEX IF NOT EXISTS automation_action_results_status_updated_idx
  ON automation_action_results(status, updated_at);

ALTER TABLE automation_action_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_action_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON automation_action_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON automation_action_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON automation_action_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON automation_action_results;
CREATE POLICY breeze_org_isolation_select ON automation_action_results
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON automation_action_results
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON automation_action_results
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON automation_action_results
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON automation_action_results TO breeze_app;
REVOKE TRUNCATE ON automation_action_results FROM breeze_app;
REVOKE TRUNCATE ON automation_action_results FROM PUBLIC;
