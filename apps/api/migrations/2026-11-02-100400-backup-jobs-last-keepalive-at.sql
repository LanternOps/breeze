-- #2798: separate backup-job LIVENESS from PROGRESS.
--
-- last_progress_at used to be bumped by every backup_progress message,
-- including the agent's 30s keepalive that re-sends unchanged counters, so a
-- live agent whose upload had wedged kept it ~30s fresh forever and the stale
-- reaper's stall rule could never fire. From now on:
--   last_keepalive_at = any lifecycle signal from the agent (liveness)
--   last_progress_at  = transferred_size or file_count actually increased
--
-- Nullable, no default: metadata-only ALTER. Existing RLS policies on
-- backup_jobs cover the new column.
ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS last_keepalive_at timestamptz;

-- Seed liveness for jobs that are in flight across the upgrade. The queue
-- lifecycle guards now test last_keepalive_at IS NULL to mean "the helper has
-- not spoken yet"; without this, the first post-upgrade progress ping on a
-- running job would restamp its started_at. Only in-flight rows matter;
-- terminal history is left NULL. Re-running is a no-op (the IS NULL guard).
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE backup_jobs
     SET last_keepalive_at = last_progress_at
   WHERE last_keepalive_at IS NULL
     AND last_progress_at IS NOT NULL
     AND status IN ('pending', 'running');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'seeded last_keepalive_at on % in-flight backup_jobs rows', n;
  END IF;
END $$;
