-- Add 'interrupted' to the device_restore_point_attempts status CHECK (#9163).
-- Agent-reported: the agent restarted, crashed or shut down before it reported
-- the checkpoint's outcome. Fix-forward: 2026-12-24-160000 and 2026-12-31-110000
-- are shipped and their content hashes are immutable. No column, no table: no
-- cascade/export-policy change. No row writes, so no breeze.scope election.
ALTER TABLE device_restore_point_attempts
  DROP CONSTRAINT IF EXISTS device_restore_point_attempts_status_chk;
ALTER TABLE device_restore_point_attempts
  ADD CONSTRAINT device_restore_point_attempts_status_chk
  CHECK (status IN (
    'requested',
    'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
    'skipped_no_mutation',
    'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed',
    'interrupted'
  ));
