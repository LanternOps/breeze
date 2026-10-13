-- Topology site location W3 (#7887, feature #7884): prospective daily presence summaries, wrong-site
-- suggestion columns on the presence read model, and the site-assignment confirmation ("Keep at <site>").
-- Spec: docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md S§7.1, S§10, S§11, S§15.
--
-- Suggestions are SUGGESTIONS: nothing in this file (or anything that reads these columns) writes
-- devices.site_id. A device changes site only when a technician explicitly accepts a suggestion through the
-- guarded PATCH /devices/:id.
--
-- Idempotent; no inner BEGIN/COMMIT; this file writes no rows (the trigger bodies write at run time; the
-- SECURITY DEFINER one elects system scope in-body and restores the caller's, as W2's triggers do).

-- ---------------------------------------------------------------------------
-- Dismissal (S§11): a confirmed assignment suppresses suggestions until the device moves or an admin clears
-- it. No expiry (owner decision Q2). The actor lives in the audit log, not in a column.
-- ---------------------------------------------------------------------------
ALTER TABLE devices ADD COLUMN IF NOT EXISTS site_assignment_confirmed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Suggestion result on the presence row (S§10.2), written by the evaluator every evaluation (NULL when not
-- eligible). The row is deleted on any site/org change by breeze_topology_presence_device_moved, so a
-- suggestion never outlives the assignment it was computed against.
-- ---------------------------------------------------------------------------
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggested_site_id uuid;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggestion_first_at timestamptz;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggestion_last_at timestamptz;
ALTER TABLE topology_device_presence ADD COLUMN IF NOT EXISTS suggestion_days smallint;
DO $$ BEGIN
  ALTER TABLE topology_device_presence ADD CONSTRAINT topology_device_presence_suggestion_days_check
    CHECK (suggestion_days IS NULL OR suggestion_days BETWEEN 0 AND 31);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE topology_device_presence ADD CONSTRAINT topology_device_presence_suggestion_chk
    CHECK ((suggested_site_id IS NULL) = (suggestion_days IS NULL)
       AND (suggested_site_id IS NULL) = (suggestion_first_at IS NULL)
       AND (suggested_site_id IS NULL) = (suggestion_last_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE topology_device_presence ADD CONSTRAINT topology_device_presence_suggested_site_fk
    FOREIGN KEY (suggested_site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS topology_device_presence_suggested_site_idx
  ON topology_device_presence (suggested_site_id) WHERE suggested_site_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Daily presence summaries (S§7.1, S§10.1). Prospective only: no backfill. Device-scoped, org-denormalized
-- (RLS shape 1 on org_id). assigned_site_id is the historical assignment, never rewritten; eligibility only
-- counts rows of the current assignment. Retained 35 days (worker prune, <= 10,000 rows per tick).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topology_device_presence_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  device_id uuid NOT NULL,
  day date NOT NULL,
  assigned_site_id uuid NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('home', 'visiting', 'unrecognized', 'ambiguous', 'stale', 'unknown')),
  matched_site_id uuid,
  match_key varchar(80) NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_device_presence_days_device_fk FOREIGN KEY (device_id, org_id)
    REFERENCES devices (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_days_assigned_site_fk FOREIGN KEY (assigned_site_id, org_id)
    REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_days_matched_site_fk FOREIGN KEY (matched_site_id, org_id)
    REFERENCES sites (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT topology_device_presence_days_visiting_chk CHECK ((state = 'visiting') = (matched_site_id IS NOT NULL)),
  CONSTRAINT topology_device_presence_days_observed_chk CHECK (last_observed_at >= first_observed_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS topology_device_presence_days_key_uniq
  ON topology_device_presence_days (device_id, day, assigned_site_id, match_key);
CREATE INDEX IF NOT EXISTS topology_device_presence_days_org_device_idx
  ON topology_device_presence_days (org_id, device_id, day);
-- Retention prune (day < cutoff, LIMIT 10,000) and site-delete cascades.
CREATE INDEX IF NOT EXISTS topology_device_presence_days_day_idx ON topology_device_presence_days (day);
CREATE INDEX IF NOT EXISTS topology_device_presence_days_assigned_site_idx ON topology_device_presence_days (assigned_site_id);
CREATE INDEX IF NOT EXISTS topology_device_presence_days_matched_site_idx
  ON topology_device_presence_days (matched_site_id) WHERE matched_site_id IS NOT NULL;

ALTER TABLE topology_device_presence_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_device_presence_days FORCE ROW LEVEL SECURITY;

-- RLS shape 1: the four standard org-isolation policies (same block as 2026-12-25-140000).
DO $$
DECLARE table_name text; command text; policy_name text; clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['topology_device_presence_days'] LOOP
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
-- W2's device-moved trigger, extended for the day rows. Full W2 body (2026-12-25-140000) plus one statement:
-- on an ORG change, delete the device's day rows first. They name source-org sites through composite
-- (x, org_id) FKs, and the AFTER trigger breeze_cascade_device_org_id() re-stamps org_id on every device-child
-- table, which would 23503 on assigned_site_id (the same reason W2 deletes the presence row here). A same-org
-- site move keeps them: they record the historical assignment, and eligibility ignores rows of a previous one.
-- Skipped while the source org is fenced for a merge: a merge repoints devices, sites and these rows to the
-- survivor together under deferred constraints (orgMergeRegistry REPOINT_TABLES), so the history survives.
-- Still writes nothing on devices and never RAISEs.
-- ---------------------------------------------------------------------------
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
  IF NEW.org_id IS DISTINCT FROM OLD.org_id AND NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    DELETE FROM public.topology_device_presence_days WHERE device_id = OLD.id;
  END IF;
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
REVOKE ALL ON FUNCTION public.breeze_topology_presence_device_moved() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Confirmation reset (S§11): any site or org change clears the confirmation, whatever the write path (PATCH,
-- move-org, org merge, a future bulk path). It only ever clears site_assignment_confirmed_at on the row being
-- updated; it never touches site_id. BEFORE triggers on devices fire in name order; this one has no ordering
-- dependency on breeze_topology_presence_device_moved or devices_pam_history_move_guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_devices_site_assignment_confirmation_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    NEW.site_assignment_confirmed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_devices_site_assignment_confirmation_reset ON public.devices;
CREATE TRIGGER breeze_devices_site_assignment_confirmation_reset
  BEFORE UPDATE OF site_id, org_id ON public.devices
  FOR EACH ROW
  WHEN (NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.org_id IS DISTINCT FROM OLD.org_id)
  EXECUTE FUNCTION public.breeze_devices_site_assignment_confirmation_reset();
