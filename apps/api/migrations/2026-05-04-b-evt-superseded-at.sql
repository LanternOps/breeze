-- email_verification_tokens.superseded_at — distinguishes "live token claimed
-- by user" (consumed_at) from "live token invalidated by a later resend"
-- (superseded_at). Without this distinction, the verify endpoint can't tell
-- the user "a newer link was sent" vs. "you already verified."
--
-- Idempotent.

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS superseded_at timestamp;
