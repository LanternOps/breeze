-- apps/api/migrations/2026-12-14-100000-ticket-push-pushover-user-key.sql
-- Per-user Pushover user key for ticket-assignment pushes. Sealed at rest
-- (encryptedColumnRegistry: ticket_push_preferences.pushover_user_key_encrypted,
-- row-bound to user_id when an encryption key id is configured). Nullable: no key = no personal Pushover delivery.
-- The table's existing user-isolation RLS policy covers the new column.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file).

ALTER TABLE ticket_push_preferences ADD COLUMN IF NOT EXISTS pushover_user_key_encrypted text;
