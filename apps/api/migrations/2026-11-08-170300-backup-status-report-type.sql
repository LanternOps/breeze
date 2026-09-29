-- Backup Provider Integration W05 (#6013, feature #6008): the `backup_status`
-- report type — an org-scoped snapshot over both Breeze first-party backups
-- and connected provider devices, laid out like Cove's "Backup & Recovery:
-- All devices" email.
--
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-11-02-100900-backup-status-completed-with-errors.sql). No DML, so no
-- breeze.scope election. Idempotent via IF NOT EXISTS.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'backup_status';
