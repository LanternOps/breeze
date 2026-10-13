-- #7188: send an automation's on-failure notification at most once per failed
-- action, including across a BullMQ stalled-job replay of the run.
--
-- #3189 made replays idempotent by never re-sending the on-failure
-- notification for a failure an earlier attempt had already recorded. A worker
-- that crashed between recording the failure and sending the alert therefore
-- lost the alert for good. The runtime now claims the notification by setting
-- failure_notified_at with a compare-and-swap (WHERE failure_notified_at IS
-- NULL) and sends only when that UPDATE wins, on a first attempt and on a
-- replay alike.
--
-- Schema only: no rows are written, so no system-scope election is needed.
-- Nullable with no default, so the ADD COLUMN is metadata-only.

ALTER TABLE automation_action_results
  ADD COLUMN IF NOT EXISTS failure_notified_at timestamptz;

COMMENT ON COLUMN automation_action_results.failure_notified_at IS
  'When an attempt of this run claimed the automation on-failure notification for this failed action. Set by CAS before sending, so replays do not re-send it (#7188).';
