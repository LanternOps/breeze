-- #2427: persist the malformed-CVE skip count of the last successful
-- vulnerability source sync. Since #2314 malformed upstream CVE ids are
-- skipped instead of aborting the sync, but the count was stdout-only —
-- a feed regression mangling a chunk of ids completed with
-- last_sync_status='ok' and no observable trace. Success paths now record
-- how many distinct malformed ids were dropped; NULL = never recorded
-- (pre-migration rows / sources that have not synced since).
ALTER TABLE vulnerability_sources
  ADD COLUMN IF NOT EXISTS last_sync_skipped_count integer;
