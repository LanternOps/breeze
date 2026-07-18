-- Align backup_jobs.started_at / completed_at to timestamptz so they match the
-- (already-timestamptz) last_progress_at column that the stale-backup-job reaper
-- COALESCEs them with. With mixed types, COALESCE(last_progress_at, started_at)
-- compares a tz-aware value against a tz-naive one, which is only correct on a
-- UTC host — the reaper's stall/absolute-timeout math silently skews on any
-- other server timezone.
--
-- Idempotent: guarded on the current column type, so re-running once the columns
-- are already timestamptz is a no-op. On UTC hosts (all Breeze droplets) PG 12+
-- performs timestamp -> timestamptz as a metadata-only change (no table
-- rewrite); the explicit `AT TIME ZONE 'UTC'` in the USING clause keeps the
-- stored instants correct regardless of the session timezone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'backup_jobs'
      AND column_name = 'started_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE backup_jobs
      ALTER COLUMN started_at TYPE timestamptz USING started_at AT TIME ZONE 'UTC';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'backup_jobs'
      AND column_name = 'completed_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE backup_jobs
      ALTER COLUMN completed_at TYPE timestamptz USING completed_at AT TIME ZONE 'UTC';
  END IF;
END $$;
