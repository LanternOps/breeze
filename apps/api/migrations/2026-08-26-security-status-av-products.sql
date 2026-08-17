-- Persist the per-product AV array the agent already posts with every
-- security-status submission (issue #3641).
--
-- `security_status.real_time_protection` is a single boolean summarising the
-- whole endpoint, derived agent-side by "first registered product reporting
-- RTP enabled wins". When that boolean is disputed (see #3593), the per-product
-- array is the only evidence that can explain the attribution — and until now
-- the API validated it on every post and then dropped it.
--
-- Mirrors the existing jsonb columns on this table (encryption_details,
-- local_admin_summary, password_policy_summary). One row per device, so the
-- storage cost is bounded.

ALTER TABLE security_status
  ADD COLUMN IF NOT EXISTS av_products jsonb;
