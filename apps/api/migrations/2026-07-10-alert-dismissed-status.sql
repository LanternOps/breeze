-- Permanent alert dismissal: add a terminal 'dismissed' alert status.
--
-- Dismissed alerts are hidden from list views by default and honored by
-- synthetic-alert evaluators (warranty expiry) so a dismissed alert is never
-- re-created for the same underlying condition.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe in PG12+ as long as the value
-- isn't *used* in the same transaction — the ADD COLUMN statements below never
-- reference 'dismissed', so this file runs safely under autoMigrate's per-file
-- transaction. Every statement is idempotent (re-application is a no-op).

ALTER TYPE alert_status ADD VALUE IF NOT EXISTS 'dismissed';

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dismissed_at timestamp;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dismissed_by uuid REFERENCES users(id);
