-- M2 (#5998) D1: device move/delete revokes EVERY topology collection source the
-- device produced, not only its M1 `agent` sources. Physical producers
-- (`discovery`, `unifi`) authenticate as the collecting device
-- (producer_id = device id) and may report into mapped sites other than the
-- device's home site, so revocation walks each affected site of the device's
-- org, in site_id order, taking that site's state lock and bumping its build
-- fence exactly like the M1 trigger did for the home site.
--
-- Replaces the function body only; the trigger created by
-- 2026-10-24-110000-topology-m1-collection.sql keeps pointing at it. No rows are
-- written by this migration (CREATE OR REPLACE FUNCTION is idempotent).
CREATE OR REPLACE FUNCTION breeze_topology_source_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_site uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id THEN RETURN NEW; END IF;
  FOR affected_site IN
    SELECT DISTINCT site_id FROM topology_collection_sources
      WHERE producer_id=OLD.id AND org_id=OLD.org_id AND revoked_at IS NULL
      ORDER BY site_id
  LOOP
    PERFORM 1 FROM topology_site_state WHERE org_id=OLD.org_id AND site_id=affected_site FOR UPDATE;
    UPDATE topology_collection_sources SET revoked_at=now(),updated_at=now(),pending_misses='{}'
      WHERE producer_id=OLD.id AND org_id=OLD.org_id AND site_id=affected_site AND revoked_at IS NULL;
    UPDATE topology_site_state SET build_fence=build_fence+1,dirty_revision=dirty_revision+1,last_build_status='pending',updated_at=now()
      WHERE org_id=OLD.org_id AND site_id=affected_site;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
