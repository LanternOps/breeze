-- Add a marker recording WHY a user was disabled, so partner-unsuspend only
-- re-enables users the suspension actually disabled — not users disabled for
-- compromise, off-boarding, or a manual admin action. Before this, unsuspend
-- did `UPDATE users SET status='active' WHERE partner_id=? AND status='disabled'`
-- and indiscriminately re-enabled every disabled user. See issue #917 (L-5).
--
-- Nullable text (NULL = "disabled for some non-suspension reason"). Adding a
-- column to the already-RLS-forced `users` table needs no policy change.

ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason text;

-- Backfill: users currently disabled under a still-suspended partner were
-- disabled by that suspension, so tag them — otherwise a post-deploy unsuspend
-- (which now filters on this marker) would silently stop restoring them.
-- Idempotent: only touches NULL rows, so re-applying is a no-op. Users disabled
-- under a non-suspended partner keep NULL and are never swept up by unsuspend.
UPDATE users u
SET disabled_reason = 'partner_suspended'
WHERE u.status = 'disabled'
  AND u.disabled_reason IS NULL
  AND u.partner_id IN (SELECT p.id FROM partners p WHERE p.status = 'suspended');
