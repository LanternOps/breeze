-- #3525 W02 — cancellation columns on script_executions.
--
-- `status` says what happened to the PROCESS. These columns say what happened
-- to the CANCEL REQUEST. They are orthogonal on purpose (spec OD8-C): a cancel
-- we could not prove reverts `status` to `cancel_prev_status` and records the
-- reason in `cancel_state`, so a row never claims the script stopped unless the
-- device proved it.
--
-- cancelled_by is a users(id) FK, matching triggered_by on the same table. The
-- AI-agent actor id is an ai_agents id, not a user id, so the service
-- probes-and-degrades to NULL exactly as services/scriptDispatch.ts already
-- does for triggered_by; only ids that survived that probe are written here.
-- ON DELETE SET NULL keeps org erasure from tripping on it.
--
-- cancel_command_id is a bare uuid, NOT a device_commands FK — same reasoning
-- as automation_run_id above it. Command rows are reaped independently, and a
-- stale id simply matches nothing.
--
-- All five columns classify as `included` in CORE_TENANT_EXPORT_POLICY: two
-- timestamps, two uuids and one status enum, with no json, jsonb or bytea among
-- them (see services/tenantExportPolicyRegistry.ts — the export-policy contract
-- fires on a new COLUMN, not only on a new table).

ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_state script_cancel_state,
  ADD COLUMN IF NOT EXISTS cancel_command_id uuid,
  ADD COLUMN IF NOT EXISTS cancel_prev_status execution_status;

-- The lifecycle either started or it did not; a state with no request time (or
-- vice versa) is unreadable by every closer. Legacy 'cancelled' rows written by
-- the old bookkeeping-only route have both NULL = "legacy, unknown", which is
-- correct and deliberately not backfilled (spec: Out of scope).
ALTER TABLE script_executions DROP CONSTRAINT IF EXISTS script_executions_cancel_state_chk;
ALTER TABLE script_executions
  ADD CONSTRAINT script_executions_cancel_state_chk
  CHECK ((cancel_state IS NULL) = (cancel_requested_at IS NULL));

-- The cancellation sweep scans only in-flight cancels. A partial index keeps it
-- off the hot path of a table that grows with every script run on every device.
CREATE INDEX IF NOT EXISTS script_executions_cancelling_idx
  ON script_executions (cancel_requested_at)
  WHERE status = 'cancelling';

-- Closers look the execution up from the cancel command's id.
CREATE INDEX IF NOT EXISTS script_executions_cancel_command_idx
  ON script_executions (cancel_command_id)
  WHERE cancel_command_id IS NOT NULL;
