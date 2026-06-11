-- @no-transaction
-- Alerts: scale indexes. The alerts table today has ZERO secondary indexes —
-- pkey + FK constraints only. Every query against it (list by org+status,
-- per-device history, rule-scoped lookups) is a sequential scan.
--
-- Hot paths (verified from mobile.ts:500-530, mcpServer.ts:1183-1187,
-- alerts/alerts.ts list endpoint):
--   1. WHERE org_id = ? AND status = ? ORDER BY triggered_at DESC LIMIT 50
--   2. WHERE device_id = ? ORDER BY triggered_at DESC
--   3. WHERE rule_id = ?  (alert rule cascade / count)
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the
-- build does not take a SHARE lock on `alerts` at deploy time.

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_org_status_triggered_at_idx
  ON alerts (org_id, status, triggered_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_device_triggered_at_idx
  ON alerts (device_id, triggered_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_rule_id_idx
  ON alerts (rule_id);
