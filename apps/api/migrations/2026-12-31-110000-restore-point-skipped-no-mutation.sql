-- Add 'skipped_no_mutation' to the device_restore_point_attempts status CHECK
-- (#4609 W07, #4758). Fix-forward: 2026-12-24-160000 is shipped and its content
-- hash is immutable. No column, no table: no cascade/export-policy change.
ALTER TABLE device_restore_point_attempts
  DROP CONSTRAINT IF EXISTS device_restore_point_attempts_status_chk;
ALTER TABLE device_restore_point_attempts
  ADD CONSTRAINT device_restore_point_attempts_status_chk
  CHECK (status IN (
    'requested',
    'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
    'skipped_no_mutation',
    'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed'
  ));
