-- Backfill setupCompletedAt for all existing users so the broadened
-- userRequiresSetup() check doesn't force them into the setup wizard.
-- Only new registrations (setupCompletedAt IS NULL) will see the wizard.
UPDATE users
SET setup_completed_at = COALESCE(last_login_at, created_at, NOW())
WHERE setup_completed_at IS NULL;
