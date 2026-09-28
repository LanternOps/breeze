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

-- 2. backup_snapshots.key_layout
--    The object-key layout a snapshot was written with. Every writer produces
--    'legacy_flat' (snapshots/<snapshotId>/...), which is also the default for
--    every existing row. Readers from this release on (retention, storage GC,
--    storage-session issuance, recovery downloads) refuse any other value
--    rather than misread it, so this release is the rollback floor for any
--    future layout: once a later release writes a different layout, running
--    an API older than this one against that database is not supported.
--    The CHECK admits one further value only so readers can be tested
--    against a layout they do not understand; no code path writes it.
--
-- DDL only: no rows are written. Idempotent.
ALTER TABLE backup_snapshots
  ADD COLUMN IF NOT EXISTS key_layout text NOT NULL DEFAULT 'legacy_flat';
DO $$
BEGIN
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_key_layout_chk CHECK (key_layout IN ('legacy_flat', 'device_scoped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
