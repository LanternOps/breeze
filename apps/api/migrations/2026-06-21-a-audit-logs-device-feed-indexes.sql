-- @no-transaction
-- Device-detail Activity pane (issue #1726): make the per-device audit feed an
-- index-backed "last N" read instead of a full-history sort.
--
-- The feed query (apps/api/src/routes/devices/events.ts) filters on an OR across
-- two columns and orders by timestamp DESC LIMIT N:
--
--   WHERE resource_id = $device
--      OR details->>'deviceId' = $device
--   ORDER BY timestamp DESC LIMIT N
--
-- The shipped scale indexes (2026-05-17-c) only get us partway:
--   * audit_logs_resource_type_id_timestamp_idx is (resource_type, resource_id,
--     timestamp DESC) — the query does NOT filter resource_type, so the leading
--     column is not a usable prefix for a resource_id-only seek.
--   * audit_logs_details_device_id_idx is on ((details->>'deviceId')) only — no
--     timestamp column, so matching rows must be sorted before LIMIT applies.
--
-- Neither branch returns rows already ordered by timestamp, so the planner
-- BitmapOrs both branches and sorts the device's whole history on every load.
-- These two composites let each branch read N pre-sorted rows directly:
--
--   * (resource_id, timestamp DESC)            -> resource_id branch
--   * ((details->>'deviceId'), timestamp DESC) -> JSONB branch
--
-- CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) avoids taking a
-- SHARE lock on audit_logs at deploy time — critical because every API route
-- writes here. IF NOT EXISTS keeps re-application a no-op.

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_resource_id_timestamp_idx
  ON audit_logs (resource_id, timestamp DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_details_device_id_timestamp_idx
  ON audit_logs ((details->>'deviceId'), timestamp DESC);
