-- @no-transaction
-- Uninstall provenance on device_commands (#3986).
--
-- self_uninstall rows are queued by three different features, and a later
-- task ("device remove" drain) needs to authenticate the uninstall command
-- to an offline agent more permissively than a normal command -- but ONLY
-- when the uninstall was queued by the device-remove flow specifically, not
-- by the other two callers. That requires knowing WHY the row was queued.
--
-- This provenance cannot live in `payload` (jsonb): payload is an open
-- container that terminalizers rewrite, and this codebase has been bitten
-- before by load-bearing security values living in a soft field that other
-- code paths can silently overwrite. uninstall_reasons is therefore its own
-- typed column.
--
-- device_commands takes this column with none of the CLAUDE.md registration
-- overhead a table normally requires:
--   * no org_id column -> not in CORE_ORG_CASCADE_DELETE_ORDER -> the
--     CORE_TENANT_EXPORT_POLICY per-column classification (which fires on
--     ADD COLUMN for any org-cascade table) does not apply here.
--   * no RLS policies -> device_commands is intentionally system-scoped
--     (agent WS path; documented INTENTIONAL_UNSCOPED) -> no policy to add.
--   * already registered in CORE_DEVICE_CASCADE_DELETE_TABLES
--     (routes/devices/core.ts) and already pre-cleared by tenantCascade.ts
--     -> no cascade registration change needed.
--
-- NO BACKFILL: existing rows keep uninstall_reasons = NULL. Every consumer
-- treats NULL as "no exemption, no widened authentication" -- fail-closed by
-- construction. Stamping a reason onto historic rows would arm a fleet-wide
-- agent-uninstall incident on deploy.
ALTER TABLE device_commands
  ADD COLUMN IF NOT EXISTS uninstall_reasons text[],
  ADD COLUMN IF NOT EXISTS device_remove_expires_at timestamptz;

-- Partial index for the drain worker: only rows that are (a) actually a
-- pending/sent self_uninstall command and (b) tagged with the device_remove
-- reason are candidates for the widened-auth drain path.
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so
-- the build does not take a SHARE lock on `device_commands` at deploy
-- time — device_commands is written from ~36 call sites on the agent hot
-- path (heartbeats, command dispatch, log ships), and a non-concurrent
-- build here would stall fleet-wide agent writes for the build's duration
-- (see autoMigrate.ts:568-572, #753 P0).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_device_remove_drain
  ON device_commands (device_id)
  WHERE type = 'self_uninstall'
    AND status IN ('pending', 'sent')
    AND uninstall_reasons @> ARRAY['device_remove']::text[];
