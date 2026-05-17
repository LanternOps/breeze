-- device_software + script_executions: scale indexes.
--
-- device_software has only its pkey today. Every per-device software list
-- query (devices/software.ts) and every /software-inventory aggregate
-- (reports/data.ts:166-177) seq-scans the entire table. At 10k devices
-- × ~150 packages = ~1.5M rows.
--
-- script_executions has only pkey + a partial index on active statuses.
-- Per-device execution history, per-script-id lookups, and org-scoped
-- completed-runs lists all seq scan today.

-- device_software
CREATE INDEX IF NOT EXISTS device_software_device_id_idx
  ON device_software (device_id);

CREATE INDEX IF NOT EXISTS device_software_name_idx
  ON device_software (name);

-- script_executions
CREATE INDEX IF NOT EXISTS script_executions_device_created_at_idx
  ON script_executions (device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS script_executions_script_id_idx
  ON script_executions (script_id);

CREATE INDEX IF NOT EXISTS script_executions_org_status_created_at_idx
  ON script_executions (org_id, status, created_at DESC);
