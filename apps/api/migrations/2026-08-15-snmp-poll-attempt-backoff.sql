-- Issue #3217: SNMP scheduler ignored polling_interval for never-succeeding devices.
--
-- The scheduler's due-check ran off `last_polled`, which is only stamped on a
-- SUCCESSFUL poll. A device that never succeeds (unreachable, bad credentials,
-- or results the pipeline cannot persist) keeps last_polled = NULL forever, so
-- it matched the `IS NULL` branch on every 60s scheduler tick regardless of its
-- configured polling_interval. The devices most likely to be broken were polled
-- the hardest, with no backoff and no cap.
--
-- Adds:
--   * last_poll_attempted_at — stamped at dispatch, whatever the outcome, so
--     the due-check can run off attempts instead of successes.
--   * consecutive_failures   — drives exponential backoff of the effective
--     polling interval.

ALTER TABLE snmp_devices
  ADD COLUMN IF NOT EXISTS last_poll_attempted_at TIMESTAMP;

ALTER TABLE snmp_devices
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN snmp_devices.last_poll_attempted_at IS
  'Stamped when a poll is dispatched, regardless of outcome. The scheduler due-check runs off GREATEST(this, last_polled) so devices that never succeed still honour polling_interval instead of being re-polled every scheduler tick. See issue #3217.';

COMMENT ON COLUMN snmp_devices.consecutive_failures IS
  'Incremented at dispatch time and reset to 0 only when poll results are successfully persisted. Pre-incrementing (rather than marking failure in a handler) is deliberate: a poll can die after dispatch — the agent may never reply, or result persistence may throw — and no catch block in the worker reliably covers those paths. Drives exponential backoff of the effective polling interval. See issue #3217.';

-- Seed the attempt column from the existing success timestamp so devices that
-- have polled successfully before are not all made instantly due on the first
-- scheduler tick after deploy.
DO $$
DECLARE
  seeded bigint;
BEGIN
  UPDATE snmp_devices
     SET last_poll_attempted_at = last_polled
   WHERE last_poll_attempted_at IS NULL
     AND last_polled IS NOT NULL;
  GET DIAGNOSTICS seeded = ROW_COUNT;
  IF seeded > 0 THEN
    RAISE WARNING 'seeded last_poll_attempted_at from last_polled for % snmp_devices rows', seeded;
  END IF;
END $$;
