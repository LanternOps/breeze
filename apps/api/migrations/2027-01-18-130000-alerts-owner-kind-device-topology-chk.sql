-- #10725 W1 review follow-up: a row classified owner_kind = 'device' must not also carry a
-- topology_site_id. The shipped 2027-01-18-100000 CHECK admitted that shape, so a topology alert
-- inserted as 'device' would be keyed and throttled by its origin device without anything flagging it.
-- Idempotent; no rows written; existing rows already satisfy the tightened predicate because every
-- topology row was classified 'topology_site' by the 2027-01-18-100000 backfill.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_owner_chk;
ALTER TABLE alerts ADD CONSTRAINT alerts_owner_chk CHECK (
     (owner_kind = 'device' AND device_id IS NOT NULL AND topology_site_id IS NULL)
  OR (owner_kind = 'topology_site' AND topology_site_id IS NOT NULL)
  OR (owner_kind = 'backup_workload' AND device_id IS NULL AND owner_ref IS NOT NULL)
);
