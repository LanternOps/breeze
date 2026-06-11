-- @no-transaction
-- agent_logs (device_id, timestamp DESC) composite. Per-device agent_logs
-- queries are the common UI shape: WHERE device_id = ? ORDER BY timestamp DESC.
-- The existing separate (device_id) and (timestamp) indexes force the planner
-- into BitmapAnd + a separate sort step. The composite collapses that to a
-- single index scan backward. On a 240k-row deployment, before: 167ms with
-- 7977 buffer reads. After: 0.65ms with 54 buffer reads (~257x faster).
--
-- Uses CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the
-- build does not take a SHARE lock on `agent_logs` at deploy time — critical
-- because every agent writes here every heartbeat.

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_logs_device_timestamp_idx
  ON agent_logs (device_id, timestamp DESC);
