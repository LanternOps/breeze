-- 2026-07-18-finder.sql — finder (phase 3) support.
-- workspace_file_activity: helper sessions have no users-table identity.
-- user_id becomes nullable; helper_user is a device-local display label
-- (max 100 chars, matches core helper session label), never authorization.

ALTER TABLE workspace_file_activity ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE workspace_file_activity ADD COLUMN IF NOT EXISTS helper_user varchar(100);

-- Recents: latest activity per device (+ optional label filter).
CREATE INDEX IF NOT EXISTS wsp_file_activity_org_device_idx
  ON workspace_file_activity (org_id, device_id, created_at DESC);

-- Search ordering: recency tiebreak within an org.
CREATE INDEX IF NOT EXISTS wsp_file_index_org_mtime_idx
  ON workspace_file_index (org_id, mtime DESC NULLS LAST);
