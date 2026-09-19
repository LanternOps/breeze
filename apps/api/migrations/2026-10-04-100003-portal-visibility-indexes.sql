-- Portal visibility Wave 1 read-model query indexes.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

CREATE INDEX IF NOT EXISTS device_patches_org_installed_at_idx
  ON device_patches (org_id, installed_at)
  WHERE status = 'installed';

CREATE INDEX IF NOT EXISTS security_threats_org_detected_at_idx
  ON security_threats (org_id, detected_at);

CREATE INDEX IF NOT EXISTS security_threats_org_resolved_at_idx
  ON security_threats (org_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS s1_threats_org_detected_at_idx
  ON s1_threats (org_id, detected_at)
  WHERE detected_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS s1_threats_org_resolved_at_idx
  ON s1_threats (org_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS huntress_incidents_org_reported_at_idx
  ON huntress_incidents (org_id, reported_at)
  WHERE reported_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS huntress_incidents_org_resolved_at_idx
  ON huntress_incidents (org_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS backup_verifications_org_completed_at_idx
  ON backup_verifications (org_id, completed_at);

CREATE INDEX IF NOT EXISTS time_entries_org_started_at_idx
  ON time_entries (org_id, started_at)
  WHERE org_id IS NOT NULL;
