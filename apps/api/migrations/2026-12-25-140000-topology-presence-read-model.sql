-- Topology site location W2 (#7886, feature #7884): the presence read model.
-- Spec: docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md S§7, S§15.
--
-- Three derived, org-scoped runtime tables (RLS shape 1, no partner owner — Partner-Wide First does not
-- apply to a read model): one state row per org, per-site network fingerprints, one presence row per bound
-- device. Fingerprint and presence rows are written and pruned by the presence evaluator (system scope); state
-- rows are also created or marked dirty by the invalidation triggers below and by the worker's enrolment, and the
-- device-moved trigger deletes a device's presence row.
-- NOTHING here writes devices.site_id: presence classifies and displays, it never moves a device.
--
-- Idempotent; no inner BEGIN/COMMIT; this file writes no rows (the trigger functions write at run time and
-- elect system scope in-body, restoring the caller's scope before RETURN, as the PAM ownership-epoch
-- triggers do in 2026-12-17-130000-device-ownership-epochs.sql).

CREATE TABLE IF NOT EXISTS topology_org_presence_state (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  fingerprint_version bigint NOT NULL DEFAULT 0 CHECK (fingerprint_version >= 0),
  coverage varchar(16) NOT NULL DEFAULT 'not_configured' CHECK (coverage IN ('complete', 'limited', 'not_configured')),
  coverage_reason varchar(64),
  dirty_at timestamptz,
  -- Bumped by every invalidation. dirty_at keeps the FIRST stamp (the debounce anchor), so only this counter tells
  -- an evaluation that a change landed after it read the state (compare-and-clear in presenceEvaluator.ts).
  dirty_seq bigint NOT NULL DEFAULT 0 CHECK (dirty_seq >= 0),
  evaluated_at timestamptz,
  next_evaluation_at timestamptz,
  input_digest varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topology_org_presence_state_due_idx
  ON topology_org_presence_state (dirty_at, next_evaluation_at);

CREATE TABLE IF NOT EXISTS topology_site_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  family varchar(8) NOT NULL DEFAULT 'ipv4' CHECK (family = 'ipv4'),
  prefix cidr NOT NULL,
  gateway_address inet,
  status varchar(16) NOT NULL CHECK (status IN ('anchored', 'unconfirmed', 'ambiguous')),
  consumer_default boolean NOT NULL DEFAULT false,
  declared_by text[] NOT NULL DEFAULT '{}' CHECK (cardinality(declared_by) <= 2),
  declaration_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(declaration_ids) <= 32),
  observer_device_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(observer_device_ids) <= 64),
  gateway_macs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(gateway_macs) = 'array' AND jsonb_array_length(gateway_macs) <= 16),
  neighbor_coverage varchar(16) NOT NULL DEFAULT 'limited' CHECK (neighbor_coverage IN ('complete', 'limited')),
  fingerprint_version bigint NOT NULL,
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_site_fingerprints_site_fk FOREIGN KEY (site_id, org_id)
    REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_site_fingerprints_key_uniq
  ON topology_site_fingerprints (org_id, site_id, prefix, coalesce(gateway_address, '0.0.0.0'::inet));
CREATE INDEX IF NOT EXISTS topology_site_fingerprints_org_prefix_idx ON topology_site_fingerprints (org_id, prefix);
CREATE INDEX IF NOT EXISTS topology_site_fingerprints_site_idx ON topology_site_fingerprints (site_id);

CREATE TABLE IF NOT EXISTS topology_device_presence (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  assigned_site_id uuid NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('home', 'visiting', 'unrecognized', 'ambiguous', 'stale', 'unknown')),
  reason varchar(48),
  matched_site_id uuid,
  declaring_site_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(declaring_site_ids) <= 8),
  prefix cidr,
  gateway_address inet,
  gateway_mac macaddr,
  mac_corroborated boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 8),
  observed_at timestamptz,
  fresh_until timestamptz,
  fingerprint_version bigint NOT NULL,
  evaluated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_device_presence_device_fk FOREIGN KEY (device_id, org_id)
    REFERENCES devices (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_matched_site_fk FOREIGN KEY (matched_site_id, org_id)
    REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_visiting_chk CHECK ((state = 'visiting') = (matched_site_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS topology_device_presence_visiting_idx
  ON topology_device_presence (org_id, matched_site_id) WHERE state = 'visiting';
CREATE INDEX IF NOT EXISTS topology_device_presence_assigned_idx ON topology_device_presence (org_id, assigned_site_id);
CREATE INDEX IF NOT EXISTS topology_device_presence_matched_site_idx ON topology_device_presence (matched_site_id);

ALTER TABLE topology_org_presence_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_org_presence_state FORCE ROW LEVEL SECURITY;
ALTER TABLE topology_site_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_site_fingerprints FORCE ROW LEVEL SECURITY;
ALTER TABLE topology_device_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_device_presence FORCE ROW LEVEL SECURITY;

-- RLS shape 1: the four standard org-isolation policies (block copied from 2026-10-22-150100-topology-foundation.sql).
DO $$
DECLARE table_name text; command text; policy_name text; clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['topology_org_presence_state','topology_site_fingerprints','topology_device_presence'] LOOP
    FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      policy_name := 'breeze_org_isolation_' || lower(command);
      clause := CASE command
        WHEN 'INSERT' THEN 'WITH CHECK (breeze_has_org_access(org_id))'
        WHEN 'UPDATE' THEN 'USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id))'
        ELSE 'USING (breeze_has_org_access(org_id))' END;
      IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
        AND p.tablename = table_name AND p.policyname = policy_name) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s', policy_name, table_name, command, clause);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO breeze_app', table_name);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Invalidation (S§7.4). "Mark dirty" stamps topology_org_presence_state.dirty_at, keeping the first stamp
-- while the org is already dirty (the worker debounces on it). p_create = false only touches an existing row:
-- the side a device or declaration is LEAVING never needs a new row (it has nothing evaluated to invalidate),
-- and creating one mid org-merge would leave the loser org a fresh state row behind its repoint.
--
-- SECURITY DEFINER with in-body system scope, saved and restored before RETURN so it never leaks into the
-- caller's transaction (an error aborts the statement, which rolls the set_config back too): the caller may be
-- a request that cannot see the org on the far side of a cross-org move, and the state table is FORCE RLS.
-- A function-level SET "breeze.scope" attribute is not usable: it needs superuser in prod.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_topology_presence_mark_dirty(p_org uuid, p_create boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  IF p_org IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('breeze.scope', 'system', true);
  IF p_create THEN
    INSERT INTO public.topology_org_presence_state (org_id, dirty_at) VALUES (p_org, now())
    ON CONFLICT (org_id) DO UPDATE
      SET dirty_at = coalesce(public.topology_org_presence_state.dirty_at, now()),
          dirty_seq = public.topology_org_presence_state.dirty_seq + 1, updated_at = now();
  ELSE
    UPDATE public.topology_org_presence_state
       SET dirty_at = coalesce(dirty_at, now()), dirty_seq = dirty_seq + 1, updated_at = now()
     WHERE org_id = p_org;
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
END;
$$;

-- Discovery profiles and network baselines are the declarations (S§6.2).
CREATE OR REPLACE FUNCTION public.breeze_topology_presence_declarations_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.breeze_topology_presence_mark_dirty(OLD.org_id, false);
  ELSIF TG_OP = 'UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    PERFORM public.breeze_topology_presence_mark_dirty(OLD.org_id, false);
    PERFORM public.breeze_topology_presence_mark_dirty(NEW.org_id, true);
  ELSE
    PERFORM public.breeze_topology_presence_mark_dirty(NEW.org_id, true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_topology_presence_profiles ON public.discovery_profiles;
CREATE TRIGGER breeze_topology_presence_profiles
  AFTER INSERT OR DELETE OR UPDATE OF subnets, enabled, site_id, org_id ON public.discovery_profiles
  FOR EACH ROW EXECUTE FUNCTION public.breeze_topology_presence_declarations_changed();

DROP TRIGGER IF EXISTS breeze_topology_presence_baselines ON public.network_baselines;
CREATE TRIGGER breeze_topology_presence_baselines
  AFTER INSERT OR DELETE OR UPDATE OF subnet, site_id, org_id ON public.network_baselines
  FOR EACH ROW EXECUTE FUNCTION public.breeze_topology_presence_declarations_changed();

-- A device's site or org change deletes its presence row and marks the org(s) dirty. BEFORE, not AFTER, and
-- load-bearing: the AFTER trigger breeze_cascade_device_org_id() re-stamps org_id on every device-child table
-- (breeze_device_child_orgid_tables()), which would carry a visiting row's (matched_site_id, org_id) into the
-- target org and fail topology_device_presence_matched_site_fk (23503) on a cross-org move. Deleting the row
-- first leaves that restamp nothing to touch. It writes nothing on devices (devices.site_id stays exactly what
-- the caller wrote: no automatic site reassignment, S§2) and never RAISEs, so it cannot obstruct a move or an
-- org-merge repoint (orgMergeRegistry.integration.test.ts ORG_ID_BENIGN_TRIGGERS).
CREATE OR REPLACE FUNCTION public.breeze_topology_presence_device_moved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  DELETE FROM public.topology_device_presence WHERE device_id = OLD.id;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    PERFORM public.breeze_topology_presence_mark_dirty(OLD.org_id, false);
    PERFORM public.breeze_topology_presence_mark_dirty(NEW.org_id, true);
  ELSE
    PERFORM public.breeze_topology_presence_mark_dirty(NEW.org_id, false);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_topology_presence_device_moved ON public.devices;
CREATE TRIGGER breeze_topology_presence_device_moved
  BEFORE UPDATE OF site_id, org_id ON public.devices
  FOR EACH ROW
  WHEN (NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.org_id IS DISTINCT FROM OLD.org_id)
  EXECUTE FUNCTION public.breeze_topology_presence_device_moved();

-- A topology publication (graph_revision advances) changes the attachment evidence. Only orgs that already
-- have declarations (a configured state row) are marked; publication alone never enrols an org.
CREATE OR REPLACE FUNCTION public.breeze_topology_presence_graph_published()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  IF NEW.graph_revision > OLD.graph_revision THEN
    PERFORM set_config('breeze.scope', 'system', true);
    UPDATE public.topology_org_presence_state
       SET dirty_at = coalesce(dirty_at, now()), dirty_seq = dirty_seq + 1, updated_at = now()
     WHERE org_id = NEW.org_id AND coverage <> 'not_configured';
    PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_topology_presence_graph_published ON public.topology_site_state;
CREATE TRIGGER breeze_topology_presence_graph_published
  AFTER UPDATE OF graph_revision ON public.topology_site_state
  FOR EACH ROW EXECUTE FUNCTION public.breeze_topology_presence_graph_published();

-- Trigger-only bodies; nobody calls them directly.
REVOKE ALL ON FUNCTION public.breeze_topology_presence_mark_dirty(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_topology_presence_declarations_changed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_topology_presence_device_moved() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_topology_presence_graph_published() FROM PUBLIC;
