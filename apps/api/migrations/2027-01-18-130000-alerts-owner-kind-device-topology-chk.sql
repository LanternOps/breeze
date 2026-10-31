-- #10725 W1 review follow-up: a row classified owner_kind = 'device' must not also carry a
-- topology_site_id. The shipped 2027-01-18-100000 CHECK admitted that shape, so a topology alert
-- inserted as 'device' would be keyed and throttled by its origin device without anything flagging it.
-- Reclassify stragglers inserted by old workers after the 2027-01-18-100000 backfill before
-- tightening the CHECK. Idempotent; report cleanup counts for the forensic trail.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE alerts SET owner_kind = 'topology_site'
  WHERE owner_kind = 'device' AND topology_site_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % topology alerts classified as device owners', n;
  END IF;
END $$;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_owner_chk;
ALTER TABLE alerts ADD CONSTRAINT alerts_owner_chk CHECK (
     (owner_kind = 'device' AND device_id IS NOT NULL AND topology_site_id IS NULL)
  OR (owner_kind = 'topology_site' AND topology_site_id IS NOT NULL)
  OR (owner_kind = 'backup_workload' AND device_id IS NULL AND owner_ref IS NOT NULL)
);
