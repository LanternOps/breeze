-- Phase 2 of #2502: hardware & OS change detection.
-- Adds two categories to the device_change_log change_type enum so the agent
-- can submit hardware (RAM/CPU/disk/BIOS/serial) and OS-version change events.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe in PG12+ as long as the new
-- value is not *used* in the same transaction. This file only ADDs the values
-- (no INSERT/DEFAULT/comparison uses them), so it runs safely under
-- autoMigrate's per-file transaction. Both statements are idempotent.

ALTER TYPE change_type ADD VALUE IF NOT EXISTS 'hardware';

ALTER TYPE change_type ADD VALUE IF NOT EXISTS 'os_version';
