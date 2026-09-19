-- @no-transaction
-- Four recurring-job predicates with no covering index, found by the
-- 2026-09-06 DB deep-dive (issue #5020) after device_process_samples
-- (#5009) showed the pattern: a hot job filters on columns that no index
-- leads with, so every call scans the table. All three scale with the fleet.
--
-- 1. snmp_metrics (org_id, timestamp)
--    rollupRawSnmpMetrics (services/metricRollups.ts) filters
--    `org_id = $1 AND timestamp >= $2 AND timestamp < $3` per org every
--    5 minutes. Only single-column device_id / oid / timestamp indexes exist
--    (0001-baseline.sql); the org_id FK is uncovered. Same shape as #5009.
--
-- 2. device_group_memberships (group_id, device_id)
--    patchSchedulerWorker (every 60 s, per group-assigned policy) and the
--    backup assignment resolver / backupSlaWorker filter `group_id = $1`.
--    The only index is the primary key (device_id, group_id) — group_id is
--    the trailing column, unusable for that predicate. device_id second so
--    member listings can be index-only.
--
-- 3. device_disks (device_id)
--    Every inventory cycle runs DELETE ... WHERE device_id = $1 then
--    reinserts (routes/agents/inventory.ts); the only index is the PK on id
--    (US prod: 32k calls / 402 ms mean over 6 days). device_network had the
--    identical gap fixed on 2026-08-07; this is the sibling that was missed.
--
-- 4. device_vulnerabilities (device_id)
--    replaceSoftwareInventoryProjection (every software-inventory sync) locks
--    the device's findings with SELECT ... FOR UPDATE WHERE device_id = $1.
--    The only candidate index is (org_id, device_id), which a device_id-only
--    predicate cannot use, so each sync scanned the table under the row lock
--    (US prod: 32,657 calls, 789 ms mean, 738 s max). The device_id FK was
--    uncovered, so device cascade deletes paid the same scan. A device-led
--    index is preferred over adding an org_id predicate to the query: the
--    ingest runs in a system-scoped context, and a stale org_id during an org
--    move would have silently skipped findings.
--
-- CREATE INDEX CONCURRENTLY: all four tables take agent writes continuously.
-- IF NOT EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY
-- build leaves an INVALID index that IF NOT EXISTS would silently accept, so
-- the DO block fails loudly. Recovery: DROP INDEX CONCURRENTLY <name>, then
-- let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS snmp_metrics_org_ts_idx
  ON public.snmp_metrics (org_id, "timestamp");

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_group_memberships_group_device_idx
  ON public.device_group_memberships (group_id, device_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_disks_device_id_idx
  ON public.device_disks (device_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS device_vulnerabilities_device_id_idx
  ON public.device_vulnerabilities (device_id);

DO $$
DECLARE
  bad text;
BEGIN
  -- Pair each index with its table so an unrelated same-named INVALID index
  -- elsewhere cannot abort this migration.
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM (VALUES
      ('public.snmp_metrics'::regclass,             'snmp_metrics_org_ts_idx'),
      ('public.device_group_memberships'::regclass, 'device_group_memberships_group_device_idx'),
      ('public.device_disks'::regclass,             'device_disks_device_id_idx'),
      ('public.device_vulnerabilities'::regclass,   'device_vulnerabilities_device_id_idx')
    ) AS expected(tbl, idx)
    JOIN pg_class c ON c.relname = expected.idx AND c.relnamespace = 'public'::regnamespace
    JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid = expected.tbl
   WHERE NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'recurring-job index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
