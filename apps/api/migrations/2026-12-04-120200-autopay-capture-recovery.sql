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
ALTER TABLE org_autopay_enrollments ADD COLUMN IF NOT EXISTS staff_email_dedupe_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE org_payment_methods ADD COLUMN IF NOT EXISTS detach_stripe_account_id text;
ALTER TABLE org_payment_methods ADD COLUMN IF NOT EXISTS detach_stripe_customer_id text;
ALTER TABLE autopay_setup_attempts ADD COLUMN IF NOT EXISTS capture_attempt_count integer NOT NULL DEFAULT 0 CHECK(capture_attempt_count>=0);
