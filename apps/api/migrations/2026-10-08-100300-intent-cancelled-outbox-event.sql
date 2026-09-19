-- #4798: cancelActionIntent wrote no intent_outbox row, so a requester
-- already told "approved and is now running" was never told a subsequent
-- cancel happened. Widens the event_type CHECK to admit 'intent_cancelled',
-- mirroring the wave-2 (#3823) widening for intent_rejected/intent_expired.
-- Idempotent: DROP IF EXISTS + re-ADD is safe to replay.

ALTER TABLE intent_outbox DROP CONSTRAINT IF EXISTS intent_outbox_event_type_check;
ALTER TABLE intent_outbox ADD CONSTRAINT intent_outbox_event_type_check CHECK (
  event_type IN (
    'intent_created', 'intent_approved', 'intent_rejected', 'intent_expired',
    'intent_cancelled', 'pam.desired_state_changed'
  )
);
