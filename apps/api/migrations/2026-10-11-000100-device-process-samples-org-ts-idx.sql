-- @no-transaction
-- device_process_samples: (org_id, timestamp) index for the per-org metric
-- rollup (apps/api/src/services/metricRollups.ts, rollupRawProcessSampleMetrics).
--
-- The rollup runs once per org every 5 minutes over a 15-minute window and
-- filters `WHERE org_id = $1 AND timestamp >= $2 AND timestamp < $3`. The table
-- only had (device_id, timestamp) indexes, so neither column order lets the
-- planner seek on org + time: it walks the ENTIRE primary-key index applying
-- the timestamp range as a condition and org_id as a filter (US prod
-- 2026-09-06: 2,182 buffers, "Rows Removed by Filter" > rows kept, 2-3.5 s per
-- scan, IO-bound in DataFileRead). The statement scans the window twice
-- (`process_devices` DISTINCT + `sample_values`), 30 orgs x 2 workers back to
-- back, so the rollup alone burned ~1.5 DB-seconds per wall-second on the
-- 1-vCPU managed instance and read ~6 GB of buffers per 90 s -- the queue
-- never drained and interactive queries were starved (v0.110.0 was already
-- deployed; #4419 single-pass rollup made each call cheaper but not the scan).
--
-- With (org_id, timestamp) the same 15-minute window is a ~100-row range seek
-- (index ~17 MB for 190k rows, sits in shared_buffers). device_metrics already
-- has the equivalent device_metrics_org_id_timestamp_idx (2026-04-11).
--
-- CREATE INDEX CONCURRENTLY: the agent heartbeat path inserts into this table
-- continuously. IF NOT EXISTS keeps re-application a no-op (prod may get the
-- index by hand ahead of the release). An interrupted CONCURRENTLY build leaves
-- an INVALID index that IF NOT EXISTS would silently accept, so the DO block
-- fails loudly in that state. Recovery: DROP INDEX CONCURRENTLY
-- device_process_samples_org_ts_idx, then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_process_samples_org_ts_idx
  ON public.device_process_samples (org_id, "timestamp");

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.device_process_samples'::regclass
     AND c.relname = 'device_process_samples_org_ts_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'device_process_samples org/timestamp index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
