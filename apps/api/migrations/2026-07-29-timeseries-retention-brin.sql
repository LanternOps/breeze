-- @no-transaction
-- Retention support indexes for the two unbounded time-series tables (#2827).
--
-- `device_metrics` and `service_process_check_results` have never had a
-- retention path, so both grow without bound (observed: 23 GB / 24 GB on a
-- single self-hosted deployment, ~630 MB/day combined).
--
-- The retention workers added alongside this migration prune by
-- `WHERE "timestamp" < cutoff` in bounded ctid batches, mirroring
-- `jobs/processSampleRetention.ts`. Neither table has an index that LEADS with
-- `timestamp`:
--
--   device_metrics                 PK (device_id, timestamp)
--                                  idx (org_id, timestamp DESC)
--   service_process_check_results  PK (id)
--                                  idx (device_id), (org_id),
--                                      (device_id, name, timestamp)
--
-- so the prune predicate plans a Seq Scan. Verified on a populated deployment:
--
--   Limit  (cost=0.00..3266.51 rows=10000 width=6)
--     ->  Seq Scan on device_metrics  (cost=0.00..3110591.46 rows=9522680 width=6)
--   Limit  (cost=0.00..756.46 rows=10000 width=6)
--     ->  Seq Scan on service_process_check_results  (cost=0.00..3114942.68 rows=41177745 width=6)
--
-- Early batches exit the scan quickly because old rows sit early in the heap,
-- but as the prune advances each batch must walk ever more live tuples to find
-- BATCH_SIZE old ones — the loop degrades toward a full scan per batch. Against
-- ~9.5M and ~41M expired rows that is thousands of scans over ~47 GB.
--
-- BRIN rather than btree: both tables are append-only and their `timestamp`
-- column is almost perfectly correlated with physical order (measured
-- `pg_stats.correlation` = 0.99926 and 0.99960). BRIN is the right structure
-- for exactly this shape — it stores per-block-range min/max instead of a tuple
-- per row, so it is kilobytes rather than the hundreds of megabytes a btree
-- would add to an already-large table, and it builds in a single sequential
-- heap pass instead of a full sort. Range predicates like `timestamp < cutoff`
-- are precisely what it accelerates.
--
-- Built CONCURRENTLY via autoMigrate's `@no-transaction` lane. A plain
-- CREATE INDEX holds a SHARE lock on the table for the whole build, and
-- `device_metrics` takes a write on every agent heartbeat — at ~23 GB that
-- would stall metric ingestion fleet-wide for the duration of the deploy.
-- Same reasoning as 2026-05-17-a-devices-scale-indexes.sql.
--
-- Idempotent: `IF NOT EXISTS` on both statements, per the no-transaction
-- idempotency contract (the file must be safe to re-apply if it fails partway
-- or the ledger INSERT fails). Note that a CONCURRENTLY build interrupted
-- mid-flight leaves an INVALID index behind, which `IF NOT EXISTS` will then
-- skip — recovery is an operator `DROP INDEX <name>` before the next deploy.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_metrics_timestamp_brin_idx
  ON device_metrics USING brin ("timestamp");

CREATE INDEX CONCURRENTLY IF NOT EXISTS spc_results_timestamp_brin_idx
  ON service_process_check_results USING brin ("timestamp");
