-- Add org_id to device_metrics for multi-tenant RLS scoping.
-- The column was added out-of-band in some dev databases and is referenced by
-- existing RLS policies, but no migration was ever written. This migration
-- brings fresh databases into alignment and is a no-op where the column
-- already exists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_metrics' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE device_metrics ADD COLUMN org_id uuid;
  END IF;
END$$;

UPDATE device_metrics dm
SET org_id = d.org_id
FROM devices d
WHERE dm.device_id = d.id AND dm.org_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_metrics'
      AND column_name = 'org_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE device_metrics ALTER COLUMN org_id SET NOT NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'device_metrics'
      AND constraint_name = 'device_metrics_org_id_organizations_id_fk'
  ) THEN
    ALTER TABLE device_metrics
      ADD CONSTRAINT device_metrics_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS device_metrics_org_id_timestamp_idx
  ON device_metrics (org_id, "timestamp" DESC);
