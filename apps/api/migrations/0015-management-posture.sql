-- Add management posture JSONB column to devices
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS management_posture JSONB;

-- GIN index for filtering by detected tools
CREATE INDEX IF NOT EXISTS devices_management_posture_categories_idx
  ON devices USING gin ((management_posture -> 'categories'));

-- Index for identity join type queries
CREATE INDEX IF NOT EXISTS devices_management_posture_join_type_idx
  ON devices ((management_posture -> 'identity' ->> 'joinType'));

-- Index for posture collection timestamp
CREATE INDEX IF NOT EXISTS devices_management_posture_collected_idx
  ON devices ((management_posture ->> 'collectedAt'));
