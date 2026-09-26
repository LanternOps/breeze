-- M3 Task 5 (W04 #5999): rollup progress for interface telemetry sources.
--
-- `telemetry_rollup_dirty_from` is the earliest raw sample time of an
-- `if_metrics` source whose 5-minute/hourly buckets are not yet final. The
-- telemetry sink lowers it (LEAST) under the source's in-flight lock whenever
-- it inserts raw samples; the maintenance job recomputes the affected closed
-- buckets under the same lock and advances it (NULL = fully rolled up).
-- Retention refuses to drop a raw day that still has unrolled samples.
--
-- Additive, nullable, no backfill. Idempotent. Writes no rows.

ALTER TABLE topology_collection_sources ADD COLUMN IF NOT EXISTS telemetry_rollup_dirty_from timestamptz;

CREATE INDEX IF NOT EXISTS topology_sources_telemetry_rollup_dirty_idx
  ON topology_collection_sources (telemetry_rollup_dirty_from)
  WHERE protocol = 'if_metrics' AND telemetry_rollup_dirty_from IS NOT NULL;
