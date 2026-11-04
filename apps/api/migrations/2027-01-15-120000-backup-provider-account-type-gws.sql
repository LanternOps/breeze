-- Widen backup_provider_devices.account_type to accept 'gws' (Google Workspace
-- SaaS rows from the Dropsuite / NinjaOne SaaS Backup provider, #10598).
-- The original CHECK (2026-10-26-120000-backup-provider-integration.sql) only
-- allowed backup_manager / m365 / unknown, so a gws insert failed with 23514
-- and aborted the whole sync for any reseller with a Google Workspace customer.
-- Drop-and-recreate is idempotent: re-running leaves the same constraint.
-- No rows are written.
ALTER TABLE backup_provider_devices DROP CONSTRAINT IF EXISTS backup_provider_devices_account_type_chk;
ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_account_type_chk
  CHECK (account_type IN ('backup_manager', 'm365', 'gws', 'unknown'));
