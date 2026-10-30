-- #10521 W1: partner-owned device groups, schema and RLS.
-- Spec: docs/superpowers/specs/devices/2026-10-28-partner-owned-device-groups-spec.md
-- Adds XOR ownership, revision columns, owner/parent integrity and dual-axis RLS.
-- No backfill; this migration writes no rows. Plan D3 keeps Drizzle orgId
-- NOT NULL until W2a; the DB column becomes nullable here. W3 adds creation.
-- The agent-auth config path needs the partner-wide SELECT branch.
-- From 2026-10-05-110000-config-policy-partner-wide-select.sql:
-- "Appending `OR (org_id IS NULL AND partner_id = ...)` to a FOR ALL
-- `USING` would ALSO widen UPDATE/DELETE row targeting to partner-wide rows —
-- an org admin could then delete their MSP's shared policy. Postgres never
-- consults FOR SELECT policies when computing UPDATE/DELETE target rows, so a
-- separate permissive FOR SELECT policy ORs into reads and nothing else."
-- Idempotent; keep device_groups_id_org_id_uniq as the composite-FK target.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.device_groups ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public.partners(id);
ALTER TABLE public.device_groups ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE public.device_groups ADD COLUMN IF NOT EXISTS filter_revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.device_groups ADD COLUMN IF NOT EXISTS evaluated_revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.device_groups ADD COLUMN IF NOT EXISTS evaluated_at timestamp;
ALTER TABLE public.device_groups ADD COLUMN IF NOT EXISTS evaluation_failed_orgs integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_groups_one_owner_chk'
    AND conrelid = 'public.device_groups'::regclass) THEN
    ALTER TABLE public.device_groups ADD CONSTRAINT device_groups_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_groups_partner_shape_chk'
    AND conrelid = 'public.device_groups'::regclass) THEN
    ALTER TABLE public.device_groups ADD CONSTRAINT device_groups_partner_shape_chk
      CHECK (partner_id IS NULL OR (site_id IS NULL AND parent_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS device_groups_partner_id_idx ON public.device_groups (partner_id) WHERE partner_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.breeze_device_groups_owner_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR (OLD.org_id IS NULL) <> (NEW.org_id IS NULL) THEN
    RAISE EXCEPTION 'device group owner is fixed at create time: partner_id is immutable and org_id may only move between organizations'
      USING ERRCODE = '23514', CONSTRAINT = 'device_groups_owner_immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_device_groups_owner_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS device_groups_owner_immutable ON public.device_groups;
CREATE TRIGGER device_groups_owner_immutable
  BEFORE UPDATE OF org_id, partner_id ON public.device_groups
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_groups_owner_immutable();

CREATE OR REPLACE FUNCTION public.breeze_device_groups_parent_owner_kind()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  current_org_id uuid;
  current_parent_id uuid;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);
  -- A deferred trigger carries the NEW of its own event; re-read the committed-to-be row.
  SELECT g.org_id, g.parent_id INTO current_org_id, current_parent_id
    FROM public.device_groups g WHERE g.id = NEW.id;
  IF FOUND AND current_org_id IS NOT NULL AND current_parent_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.device_groups parent
        WHERE parent.id = current_parent_id AND parent.org_id IS NULL) THEN
    RAISE EXCEPTION 'an organization device group cannot have a partner-owned parent'
      USING ERRCODE = '23514', CONSTRAINT = 'device_groups_parent_owner_kind';
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_device_groups_parent_owner_kind() FROM PUBLIC;
DROP TRIGGER IF EXISTS device_groups_parent_owner_kind ON public.device_groups;
CREATE CONSTRAINT TRIGGER device_groups_parent_owner_kind
  AFTER INSERT OR UPDATE OF parent_id, org_id, partner_id ON public.device_groups
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_groups_parent_owner_kind();

ALTER TABLE public.device_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_groups;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_groups;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_groups;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_groups;
DROP POLICY IF EXISTS device_groups_owner_isolation ON public.device_groups;
CREATE POLICY device_groups_owner_isolation ON public.device_groups
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
DROP POLICY IF EXISTS device_groups_partner_wide_select ON public.device_groups;
CREATE POLICY device_groups_partner_wide_select ON public.device_groups
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
