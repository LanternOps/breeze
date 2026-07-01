-- Partial index backing the suppression-expiry reaper's due-rows scan
-- (apps/api/src/jobs/suppressionExpiryReaper.ts). Only timed suppressions
-- (suppressed_until NOT NULL) are ever reaped; Forever suppressions (NULL) are
-- excluded by design, so they are excluded from the index too.
CREATE INDEX IF NOT EXISTS idx_alerts_suppressed_expiry
  ON alerts (suppressed_until)
  WHERE status = 'suppressed' AND suppressed_until IS NOT NULL;
