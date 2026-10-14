-- Physical placement and circuits V1, Wave 1-B: WAN role support tables,
-- circuits, circuit terminations, circuit served sites, and the hard-delete
-- trigger that marks circuits for reassociation.
--
-- Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
--       (§5.2 WAN role, §5.3-§5.5 tables, §5.4 trigger, §7 tenancy, §12 registrations)
-- Discussion #8134.
--
-- Tenancy shape 1 (direct org_id NOT NULL) for all three tables. Every composite
-- FK that references org_id is DEFERRABLE INITIALLY IMMEDIATE so org merge can
-- defer and repoint. No primary_site_id is stored anywhere (spec D-primary-site).
--
-- Idempotent; no inner BEGIN/COMMIT. DDL + one trigger function; no data writes.

-- Composite key on topology_interfaces so (interface_id, org_id) can be
-- referenced by a deferrable FK. id is already globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS topology_interfaces_id_org_uniq
  ON topology_interfaces(id, org_id);

CREATE TABLE IF NOT EXISTS circuits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL
    CONSTRAINT circuits_org_id_organizations_id_fk REFERENCES organizations(id),
  provider_name         varchar(255) NOT NULL,
  cid                   varchar(255) NOT NULL,
  bandwidth_bps         bigint,
  service_type          varchar(64),
  administrative_status varchar(24) NOT NULL DEFAULT 'active',
  needs_reassociation   boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT circuits_provider_name_chk
    CHECK (length(btrim(provider_name)) BETWEEN 1 AND 255),
  CONSTRAINT circuits_cid_chk
    CHECK (length(btrim(cid)) BETWEEN 1 AND 255),
  CONSTRAINT circuits_bandwidth_chk
    CHECK (bandwidth_bps IS NULL OR bandwidth_bps > 0),
  CONSTRAINT circuits_administrative_status_chk
    CHECK (administrative_status IN ('active','planned','suspended','disconnected')),
  CONSTRAINT circuits_id_org_uniq UNIQUE (id, org_id)
);

CREATE INDEX IF NOT EXISTS circuits_org_id_idx ON circuits(org_id);
CREATE INDEX IF NOT EXISTS circuits_org_id_cid_idx ON circuits(org_id, cid);

-- At most one current termination per circuit (PK) and per interface (UNIQUE).
CREATE TABLE IF NOT EXISTS circuit_terminations (
  circuit_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL
    CONSTRAINT circuit_terminations_org_id_organizations_id_fk REFERENCES organizations(id),
  interface_id uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT circuit_terminations_interface_id_uniq UNIQUE (interface_id)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'circuit_terminations_circuit_org_fk'
       AND conrelid = 'public.circuit_terminations'::regclass
  ) THEN
    ALTER TABLE circuit_terminations
      ADD CONSTRAINT circuit_terminations_circuit_org_fk
      FOREIGN KEY (circuit_id, org_id) REFERENCES circuits(id, org_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'circuit_terminations_interface_org_fk'
       AND conrelid = 'public.circuit_terminations'::regclass
  ) THEN
    ALTER TABLE circuit_terminations
      ADD CONSTRAINT circuit_terminations_interface_org_fk
      FOREIGN KEY (interface_id, org_id) REFERENCES topology_interfaces(id, org_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS circuit_terminations_org_id_idx ON circuit_terminations(org_id);

-- Additional served sites only; the primary site is derived and never stored here.
CREATE TABLE IF NOT EXISTS circuit_served_sites (
  circuit_id uuid NOT NULL,
  site_id    uuid NOT NULL,
  org_id     uuid NOT NULL
    CONSTRAINT circuit_served_sites_org_id_organizations_id_fk REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circuit_id, site_id)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'circuit_served_sites_circuit_org_fk'
       AND conrelid = 'public.circuit_served_sites'::regclass
  ) THEN
    ALTER TABLE circuit_served_sites
      ADD CONSTRAINT circuit_served_sites_circuit_org_fk
      FOREIGN KEY (circuit_id, org_id) REFERENCES circuits(id, org_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'circuit_served_sites_site_org_fk'
       AND conrelid = 'public.circuit_served_sites'::regclass
  ) THEN
    ALTER TABLE circuit_served_sites
      ADD CONSTRAINT circuit_served_sites_site_org_fk
      FOREIGN KEY (site_id, org_id) REFERENCES sites(id, org_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS circuit_served_sites_org_id_idx ON circuit_served_sites(org_id);

-- RLS: shape 1 on all three tables, in the same migration that creates them.
ALTER TABLE circuits ENABLE ROW LEVEL SECURITY;
ALTER TABLE circuits FORCE ROW LEVEL SECURITY;
ALTER TABLE circuit_terminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE circuit_terminations FORCE ROW LEVEL SECURITY;
ALTER TABLE circuit_served_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE circuit_served_sites FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON circuits;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON circuits;
DROP POLICY IF EXISTS breeze_org_isolation_update ON circuits;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON circuits;
CREATE POLICY breeze_org_isolation_select ON circuits
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON circuits
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON circuits
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON circuits
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON circuit_terminations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON circuit_terminations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON circuit_terminations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON circuit_terminations;
CREATE POLICY breeze_org_isolation_select ON circuit_terminations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON circuit_terminations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON circuit_terminations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON circuit_terminations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON circuit_served_sites;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON circuit_served_sites;
DROP POLICY IF EXISTS breeze_org_isolation_update ON circuit_served_sites;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON circuit_served_sites;
CREATE POLICY breeze_org_isolation_select ON circuit_served_sites
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON circuit_served_sites
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON circuit_served_sites
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON circuit_served_sites
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON circuits TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON circuit_terminations TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON circuit_served_sites TO breeze_app;

-- Hard delete of a terminating interface (spec §5.4). Site and node deletes reach
-- topology_interfaces only through FK cascade, so this BEFORE DELETE trigger is the
-- only writer of circuits.needs_reassociation on those lifecycle paths. The FK
-- cascade then removes the termination row and the circuit survives.
-- SECURITY INVOKER: the trigger runs with the deleting role's privileges.
CREATE OR REPLACE FUNCTION breeze_mark_circuit_reassociation_on_interface_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE circuits c
     SET needs_reassociation = true,
         updated_at = now()
   WHERE c.org_id = OLD.org_id
     AND c.id IN (
       SELECT t.circuit_id
         FROM circuit_terminations t
        WHERE t.interface_id = OLD.id
          AND t.org_id = OLD.org_id
     );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS breeze_circuit_reassociation_on_interface_delete ON topology_interfaces;
CREATE TRIGGER breeze_circuit_reassociation_on_interface_delete
  BEFORE DELETE ON topology_interfaces
  FOR EACH ROW
  EXECUTE FUNCTION breeze_mark_circuit_reassociation_on_interface_delete();
