-- Notification channel test: persist the failure REASON, not just the verdict.
--
-- #3697. `last_test_status` already records success/failed and #3733 put that
-- verdict on the card as text. What is still missing is WHY a test failed:
-- the provider's message (e.g. Resend's "Invalid `to` field. Please use our
-- testing email address instead of domains like `example.com`") is returned in
-- the HTTP body and toasted for five seconds, then lost forever. An operator
-- who reloads the page sees "Failed" with no way to learn what to fix.
--
-- Mirrors the shape already used by the TD SYNNEX integration panels
-- (last_test_status / last_test_at / last_test_error), so the card can render
-- the reason the same way those do.
--
-- No RLS work: notification_channels already has RLS enabled + forced with
-- org/partner dual-axis policies covering every command (baseline +
-- 2026-07-01 partner ownership). A new column inherits them.
--
-- The column IS registered in CORE_TENANT_EXPORT_POLICY (bucket `included`,
-- alongside the existing last_test_status) in the same PR — every column of an
-- org-cascade table must be classified.

ALTER TABLE public.notification_channels
  ADD COLUMN IF NOT EXISTS last_test_error text;

COMMENT ON COLUMN public.notification_channels.last_test_error IS
  'Provider failure message from the most recent channel test (#3697). NULL when the last test passed or the channel was never tested. Secret-scrubbed and length-capped by the API before write.';
