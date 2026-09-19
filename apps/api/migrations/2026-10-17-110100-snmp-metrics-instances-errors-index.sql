-- @no-transaction
-- Network device page truth W01 (spec §7.3, §7.5) — server-side ingestion of
-- the protocol-2 SNMP result shape, BEFORE any agent ships it (§7.4 is W02).
--
-- base_oid / instance: a walked table column emits one row per instance
-- (base_oid = the column OID, instance = the row suffix). Legacy agents send
-- neither, and the server writes base_oid = NULL for them; §6.2's derivation
-- matches legacy rows by `oid` instead. There is NO backfill, deliberately: a
-- historical row's oid IS its base oid, and rewriting 30 days of hot metric
-- rows to say so buys nothing the COALESCE in the read already gives.
--
-- error: the per-OID failure code a protocol-2 agent reports
-- (noSuchObject | noSuchInstance | endOfMib | timeout | truncated). Such a row
-- stores value = NULL, value_type = 'error'. `value_type` is varchar(20), not
-- an enum, so 'error' needs no DDL.
--
-- The index serves GET /monitoring/assets/:id/metrics (§6.3), which scans one
-- device, one or more OIDs, over a time window. Existing indexes are
-- single-column (device_id), (oid), (timestamp) — none serves the triple, and
-- the metrics endpoint's 90-day cap makes a seq scan on this table untenable.
--
-- @no-transaction + CREATE INDEX CONCURRENTLY (same lane as
-- 2026-10-15-160130-agent-log-receipt-time-indexes.sql): snmp_metrics is a hot
-- agent-write table and a plain CREATE INDEX would hold a SHARE lock for the
-- whole build at deploy time. Every statement below is independently
-- idempotent for autoMigrate's no-transaction retry lane.
--
-- OPERATOR NOTE — an interrupted CONCURRENTLY build leaves an INVALID index
-- that IF NOT EXISTS silently retains. Recovery is
-- `DROP INDEX CONCURRENTLY snmp_metrics_device_oid_ts_idx;` then re-apply.
-- On a large production snmp_metrics, build it by hand first (no downtime):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS snmp_metrics_device_oid_ts_idx
--     ON snmp_metrics (device_id, oid, "timestamp" DESC);
-- confirm indisvalid = true, then this migration is instant on deploy.
--
-- No DML, so no breeze.scope election. No new table, so no RLS/cascade change;
-- the three new COLUMNS do require a CORE_TENANT_EXPORT_POLICY update, shipped
-- in the same commit.

ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS base_oid VARCHAR(200);

ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS instance VARCHAR(64);

ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS error VARCHAR(32);

CREATE INDEX CONCURRENTLY IF NOT EXISTS snmp_metrics_device_oid_ts_idx
  ON snmp_metrics (device_id, oid, "timestamp" DESC);
