-- Backfill setupCompletedAt for existing users whose partner already has
-- organizations (i.e., they're already set up and working).
-- Users whose partner has NO organizations (fresh registrations that never
-- got the wizard) are left with NULL so they'll see the setup wizard.
UPDATE users u
SET setup_completed_at = COALESCE(u.last_login_at, u.created_at, NOW())
WHERE u.setup_completed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM partner_users pu
    JOIN organizations o ON o.partner_id = pu.partner_id
    WHERE pu.user_id = u.id
  );
