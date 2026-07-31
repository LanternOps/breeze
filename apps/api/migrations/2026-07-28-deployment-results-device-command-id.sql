-- Software deployment visibility (PR 1, §1.1): link a deployment result to the
-- device_commands row created by the offline-queue fallback, enabling result
-- reconciliation, cancel purge, and "queued — device offline" display.
-- Nullable and intentionally NO foreign key: device_commands is the agent hot
-- path and is kept unconstrained/system-scoped.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

ALTER TABLE deployment_results ADD COLUMN IF NOT EXISTS device_command_id uuid;
