-- Axcient x360Recover AutoVerify evidence (#11270): the provider's last boot
-- check of a recovery point, per device. Nullable with no default; Cove and
-- Dropsuite rows stay NULL. Evidence only: it never changes `status`.
--
-- Sorts after 2027-01-22-205900-external-backup-status-paused.sql, which adds
-- the `paused` label in its own transaction. DDL only (no row writes, so no
-- breeze.scope election). Idempotent. Export policy: all three `included`
-- (text[] is not an open container).
ALTER TABLE backup_provider_devices ADD COLUMN IF NOT EXISTS verified_bootable_at timestamptz;
ALTER TABLE backup_provider_devices ADD COLUMN IF NOT EXISTS verified_bootable boolean;
ALTER TABLE backup_provider_devices ADD COLUMN IF NOT EXISTS verified_bootable_failed_checks text[];
