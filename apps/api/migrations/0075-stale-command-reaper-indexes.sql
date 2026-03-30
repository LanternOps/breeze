-- Partial indexes for the stale command reaper
-- These ensure reaper queries only scan active (non-terminal) rows

CREATE INDEX IF NOT EXISTS idx_device_commands_pending_created
  ON device_commands (created_at)
  WHERE status IN ('pending', 'sent');

CREATE INDEX IF NOT EXISTS idx_script_executions_active_created
  ON script_executions (created_at)
  WHERE status IN ('pending', 'queued', 'running');

CREATE INDEX IF NOT EXISTS idx_patch_job_results_active_created
  ON patch_job_results (created_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_deployment_devices_active_started
  ON deployment_devices (started_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_remote_sessions_pending_created
  ON remote_sessions (created_at)
  WHERE status IN ('pending', 'connecting');
