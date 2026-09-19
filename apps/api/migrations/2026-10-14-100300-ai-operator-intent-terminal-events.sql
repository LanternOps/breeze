-- #5205 W05 (#5210), spec §6.3, baseline §3.3: there was no `intent_outbox`
-- event for "this intent's execution finished" — the release worker's
-- terminalizeIntent (completed/failed) and the stale-executing reaper
-- (failed:execution_lost) both published nothing at all. A task-linked
-- intent's completion or failure is the durable "the effect finished" signal
-- the AI Operator task coordinator (W06) wakes on; without it a task stays
-- stranded in `waiting` until its deadline.
--
-- Fifth widening of intent_outbox_event_type_check (see
-- 2026-09-04-ai-agent-notifications.sql, 2026-09-16-pam-actuation-lifecycle.sql,
-- 2026-09-19-ai-agents-ticket-shadow.sql, 2026-10-08-100300-intent-cancelled-outbox-event.sql).
-- Adds ONLY 'intent_completed'/'intent_failed' — no existing value removed or
-- renamed. Idempotent: DROP IF EXISTS + re-ADD is safe to replay.

ALTER TABLE intent_outbox DROP CONSTRAINT IF EXISTS intent_outbox_event_type_check;
ALTER TABLE intent_outbox ADD CONSTRAINT intent_outbox_event_type_check CHECK (
  event_type IN (
    'intent_created', 'intent_approved', 'intent_rejected', 'intent_expired',
    'intent_cancelled', 'intent_completed', 'intent_failed', 'pam.desired_state_changed'
  )
);
