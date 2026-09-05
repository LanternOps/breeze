-- 2026-10-10-100000-device-external-links.sql
-- Durable device identity for re-import (#3257 W06), mirroring
-- organization_external_links (2026-08-08) and contact_external_links
-- (2026-08-19). Every migration source exports a stable device UID (Datto
-- `uid`, Ninja device id, Automate `ComputerID`, N-central `applianceID`);
-- recording it on the first successful match turns a fuzzy hostname join into
-- an exact lookup on every subsequent run, which is what makes a multi-day
-- migration (import, enroll more machines, re-import) work at all.
--
-- The unique key is on the PARTNER axis, matching organization_external_links
-- and NOT contact_external_links: a Datto UID is unique across the Datto
-- tenant, which is partner-shaped, and a partner key survives moveOrg
-- untouched. `source_instance` is RESERVED (Open Decision 2): it ships nullable
-- and unused but is in the unique index from day one via COALESCE, so adopting
-- an account/instance discriminator later (two Datto tenants, or two unrelated
-- CSVs both keyed '1') is a BACKFILL rather than a migration of a unique key.
--
-- Tenancy shape 1 (direct org_id). No writes in this file, so no
-- breeze.scope elevation is required.

CREATE TABLE IF NOT EXISTS device_external_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL,
  org_id          uuid NOT NULL,
  partner_id      uuid NOT NULL,
  system          text NOT NULL,
  source_instance text,
  external_id     text NOT NULL,
  label           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  -- (device_id, org_id) -> devices(id, org_id) structurally pins every link row
  -- to the SAME org as its device (devices_id_org_id_uniq, 2026-07-23).
  -- DEFERRABLE INITIALLY DEFERRED matches device_mtls_certificates: the org
  -- merge re-points parent and child org_id in separate statements, and the
  -- device-move trigger loop (breeze_device_child_orgid_tables) restamps this
  -- table mid-statement alongside the devices UPDATE.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_external_links_device_org_fk') THEN
    ALTER TABLE device_external_links
      ADD CONSTRAINT device_external_links_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- (org_id, partner_id) -> organizations(id, partner_id) keeps the
  -- denormalised partner_id (which carries the unique key) honest.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_external_links_org_partner_fk') THEN
    ALTER TABLE device_external_links
      ADD CONSTRAINT device_external_links_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_external_links_uniq
  ON device_external_links (partner_id, system, COALESCE(source_instance, ''), external_id);
CREATE INDEX IF NOT EXISTS device_external_links_device_idx ON device_external_links (device_id);
CREATE INDEX IF NOT EXISTS device_external_links_org_idx ON device_external_links (org_id);

ALTER TABLE device_external_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_external_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_external_links;
CREATE POLICY breeze_org_isolation_select ON device_external_links FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_external_links FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_external_links FOR UPDATE
  USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_external_links FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_external_links TO breeze_app;

-- device_hardware declares NO index beyond its device_id primary key, so a
-- serial-keyed resolution pass across a partner is a sequential scan per
-- lookup. Expression-indexed on the NORMALISED form, because the resolver
-- compares upper(btrim(serial_number)) on both sides of the join.
CREATE INDEX IF NOT EXISTS device_hardware_org_serial_idx
  ON device_hardware (org_id, upper(btrim(serial_number)))
  WHERE serial_number IS NOT NULL;

-- devices.hostname has no case-insensitive index either, and the resolver's
-- last-resort pass is case-insensitive by design.
CREATE INDEX IF NOT EXISTS devices_org_hostname_lower_idx
  ON devices (org_id, lower(hostname));
