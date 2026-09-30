-- devices.backup_read_protocol_version / backup_integrity_protocol_version /
-- backup_write_protocol_version: NULL now means "not reported yet".
--
-- The three columns hold the protocols the INSTALLED backup helper reports on
-- every heartbeat. They were NOT NULL DEFAULT 0, so a device whose first
-- heartbeat had not arrived yet read exactly like an older helper, and a
-- backup started in that window was delivered the way an older helper gets
-- it. From this migration on, a new device row starts with NULL (unknown),
-- the heartbeat writes a number on every beat as before (a heartbeat that
-- omits a field still records 0), and backup/restore dispatch waits for the
-- first report instead of treating unknown as 0.
--
-- Existing rows keep their current values; nothing is backfilled.
--
-- DDL only: no rows are written, so no breeze.scope election. Both statements
-- are catalog-only (no table rewrite, no scan), and re-applying them is a
-- no-op. They still take a brief ACCESS EXCLUSIVE lock on a table every
-- heartbeat writes, so wait at most a few seconds for it rather than queue
-- heartbeats behind a long-running transaction; the file is idempotent and
-- safe to retry. autoMigrate wraps the file in one transaction, so SET LOCAL
-- covers every statement below.
SET LOCAL lock_timeout = '5s';

ALTER TABLE devices
  ALTER COLUMN backup_read_protocol_version DROP NOT NULL,
  ALTER COLUMN backup_read_protocol_version DROP DEFAULT,
  ALTER COLUMN backup_integrity_protocol_version DROP NOT NULL,
  ALTER COLUMN backup_integrity_protocol_version DROP DEFAULT,
  ALTER COLUMN backup_write_protocol_version DROP NOT NULL,
  ALTER COLUMN backup_write_protocol_version DROP DEFAULT;
