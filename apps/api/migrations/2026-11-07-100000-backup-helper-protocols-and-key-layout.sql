-- Backup helper protocol versions and snapshot object-key layout.
--
-- 1. devices.backup_integrity_protocol_version / backup_write_protocol_version
--    Protocol versions the INSTALLED backup helper implements, reported by the
--    main agent as top-level heartbeat fields (breeze-backup --protocol-info).
--    0 = none: the default, every existing row, and every agent that omits
--    the field. Rewritten on every heartbeat (non-sticky), exactly like
--    backup_read_protocol_version, so a helper downgrade clears the claim on
--    the next beat.
--
-- DDL only: no rows are written. Idempotent.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS backup_integrity_protocol_version integer NOT NULL DEFAULT 0;
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS backup_write_protocol_version integer NOT NULL DEFAULT 0;
