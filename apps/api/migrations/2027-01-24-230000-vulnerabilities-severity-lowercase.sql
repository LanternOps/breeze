-- #11902: the NVD and MSRC feed clients stored severity as the feed sent it
-- ('CRITICAL', 'Critical'), while the list filter and the web contract use
-- lowercase. The clients now write lowercase; this normalises existing rows.
--
-- `vulnerabilities` is the global CVE catalog (not tenant-scoped). Idempotent:
-- the predicate matches only rows that are not already lowercase, so a re-run
-- touches nothing. Plain set-based UPDATE — batching inside the per-file
-- transaction would not release locks, and rows are only the catalog's
-- distinct CVEs.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE vulnerabilities
     SET severity = lower(severity)
   WHERE severity IS NOT NULL
     AND severity <> lower(severity);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'lowercased severity on % vulnerabilities rows (#11902)', n;
  END IF;
END $$;
