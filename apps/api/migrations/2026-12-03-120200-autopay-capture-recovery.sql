SELECT set_config('breeze.scope','system',true);
-- Bound pay-and-save attempts are the durable recovery queue. Discovery still
-- stops at 24 hours; this deadline rotates failed/no-op captures fairly.
ALTER TABLE autopay_setup_attempts
  ADD COLUMN IF NOT EXISTS capture_next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS autopay_setup_attempts_capture_due_idx
  ON autopay_setup_attempts(capture_next_attempt_at,id)
  WHERE completed_at IS NULL AND source = 'pay_and_save' AND checkout_session_id IS NOT NULL;
-- Discovery yields after each examination while keeping its 24-hour cutoff.
ALTER TABLE autopay_setup_attempts
  ADD COLUMN IF NOT EXISTS discovery_next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS autopay_setup_attempts_discovery_due_idx
  ON autopay_setup_attempts(discovery_next_attempt_at,created_at,id)
  WHERE completed_at IS NULL;
