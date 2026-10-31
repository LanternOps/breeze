-- Alerts remain org-scoped; device_id is optional provenance for non-device owners.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE alerts ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_kind varchar(30) NOT NULL DEFAULT 'device';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_ref varchar(128);

UPDATE alerts SET owner_kind = 'topology_site'
WHERE topology_site_id IS NOT NULL AND owner_kind = 'device';

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_owner_chk;
ALTER TABLE alerts ADD CONSTRAINT alerts_owner_chk CHECK (
     (owner_kind = 'device' AND device_id IS NOT NULL)
  OR (owner_kind = 'topology_site' AND topology_site_id IS NOT NULL)
  OR (owner_kind = 'backup_workload' AND device_id IS NULL AND owner_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_owner_uidx
  ON alerts (org_id, owner_kind, owner_ref)
  WHERE owner_kind NOT IN ('device', 'topology_site')
    AND status IN ('active', 'acknowledged', 'suppressed');
