-- Topology M3 Task 8 (amendment M3-D6): site-owned topology policy alerts.
--
-- A recurring topology check alert belongs to the TOPOLOGY SITE that owns the
-- policy, not to the executing (origin) device, which is provenance only
-- (alerts.device_id stays NOT NULL and carries it). Additive and minimal
-- because `alerts` is core and also being changed by the alerting
-- consolidation feature (#6367):
--   - two nullable columns, set together (topology alerts only);
--   - an origin-independent unique OPEN source key (policy/context/family);
--   - a composite (topology_site_id, org_id) -> sites(id, org_id) FK,
--     DEFERRABLE INITIALLY IMMEDIATE for org merge;
--   - an immutability guard: ownership never changes, and a device move-org
--     (breeze_cascade_device_org_id re-stamps alerts by device_id) cannot carry
--     a site-owned alert into the device's new org — its org_id stays with the
--     site. A merge (source org fenced 'merging') moves site and alert together.
-- Schema only; no rows are written.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS topology_site_id uuid;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS topology_source_key text;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_topology_owner_chk;
ALTER TABLE alerts ADD CONSTRAINT alerts_topology_owner_chk CHECK (
  (topology_site_id IS NULL) = (topology_source_key IS NULL)
  AND (topology_source_key IS NULL OR topology_source_key ~ '^topology:[a-f0-9]{64}$'));

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_topology_site_fk;
ALTER TABLE alerts ADD CONSTRAINT alerts_topology_site_fk FOREIGN KEY (topology_site_id, org_id)
  REFERENCES sites(id, org_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_topology_open_source_uidx
  ON alerts (org_id, topology_site_id, topology_source_key)
  WHERE topology_source_key IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed');
CREATE INDEX IF NOT EXISTS alerts_topology_site_idx ON alerts (topology_site_id) WHERE topology_site_id IS NOT NULL;

CREATE OR REPLACE FUNCTION breeze_alerts_topology_ownership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.topology_site_id IS NULL THEN
    IF NEW.topology_site_id IS NOT NULL OR NEW.topology_source_key IS NOT NULL THEN
      RAISE EXCEPTION 'topology alert ownership is set only at insert' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.topology_site_id IS DISTINCT FROM OLD.topology_site_id OR NEW.topology_source_key IS DISTINCT FROM OLD.topology_source_key THEN
    RAISE EXCEPTION 'topology alert ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id AND NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    -- Device move-org: the origin device leaves; the site-owned alert stays.
    NEW.org_id := OLD.org_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_alerts_topology_ownership_guard ON alerts;
CREATE TRIGGER breeze_alerts_topology_ownership_guard BEFORE UPDATE OF org_id, topology_site_id, topology_source_key ON alerts
  FOR EACH ROW EXECUTE FUNCTION breeze_alerts_topology_ownership_guard();
