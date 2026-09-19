-- #6108 — widen snmp_metrics.instance from VARCHAR(64) to VARCHAR(200).
--
-- 2026-10-17-110100-snmp-metrics-instances-errors-index.sql added the column at
-- VARCHAR(64) while `oid` and `base_oid` are both VARCHAR(200). A walked table
-- row's instance is the OID suffix, which for an index-by-value table is as long
-- as the value itself: `snmpwalk` of inetCidrRouteTable on a stock Ubuntu snmpd
-- returns 110-char suffixes for IPv6 destinations. Because a poll's metrics are
-- written as ONE multi-row INSERT, a single such row aborted the statement with
-- 22001 and EVERY metric from that poll was lost, silently (the agent reported
-- success, so snmp_devices.last_error never fired).
--
-- Matching `oid`/`base_oid` at 200 is the right ceiling: an instance suffix is
-- always a proper suffix of the fully-qualified `oid`, so anything that fits in
-- `oid` fits here. The ingest path also drops (and reports) a row that still
-- exceeds the column rather than losing the whole poll.
--
-- Widening a varchar's length limit is a catalog-only change in PostgreSQL
-- (no table rewrite, no full scan) — safe on a hot table. It takes a brief
-- ACCESS EXCLUSIVE lock, which is why it is guarded below: on a DB that has
-- already been widened, the statement is skipped entirely instead of taking the
-- lock again. There is no TimescaleDB hypertable or compression policy on
-- snmp_metrics (apps/api/migrations/optional/timescaledb-setup.sql does not
-- reference it), so no decompress/recompress dance is needed.
--
-- DDL only — no INSERT/UPDATE/DELETE, so no `breeze.scope` election is required
-- (apps/api/src/db/migrationRlsScope.test.ts). No new table and no new column,
-- so RLS, the cascade lists and CORE_TENANT_EXPORT_POLICY are all unchanged.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'snmp_metrics'
      AND column_name = 'instance'
      AND character_maximum_length IS NOT NULL
      AND character_maximum_length < 200
  ) THEN
    ALTER TABLE snmp_metrics ALTER COLUMN instance TYPE VARCHAR(200);
  END IF;
END $$;
