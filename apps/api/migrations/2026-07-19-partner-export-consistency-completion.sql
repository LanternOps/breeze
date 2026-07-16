-- Complete partner-export transaction consistency for empty snapshots, hard
-- deletes, hardware disappearance, repeated multi-table locks, and ownership
-- of the material watermark columns. Fix-forward from 2026-07-18.

-- A legitimate multi-table transaction (for example device then hardware org
-- rewrites) may request the same canonical org set more than once. Skip locks
-- already held by this transaction before enforcing monotonic acquisition.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_orgs_exclusive(org_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id uuid;
  previous_max uuid;
  partner_ids uuid[];
  held_orgs uuid[];
BEGIN
  SELECT array_agg(DISTINCT o.partner_id ORDER BY o.partner_id)
    INTO partner_ids
    FROM public.organizations AS o
   WHERE o.id = ANY(COALESCE(org_ids, ARRAY[]::uuid[]));
  PERFORM public.breeze_partner_export_lock_partners_shared(partner_ids);

  FOR org_id IN
    SELECT DISTINCT value AS org_id
      FROM unnest(COALESCE(org_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY org_id
  LOOP
    held_orgs := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_org_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF org_id = ANY(held_orgs) THEN CONTINUE; END IF;
    previous_max := NULLIF(current_setting('breeze.partner_export_org_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND org_id < previous_max THEN
      RAISE EXCEPTION 'partner export organization locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock(1000201, hashtext(org_id::text));
    PERFORM set_config('breeze.partner_export_org_lock_max', org_id::text, true);
    PERFORM set_config('breeze.partner_export_org_lock_held', '1', true);
    PERFORM set_config(
      'breeze.partner_export_org_locks',
      array_to_string(array_append(held_orgs, org_id), ','),
      true
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_orgs_shared(org_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id uuid;
  previous_max uuid;
  held_orgs uuid[];
BEGIN
  IF NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '') IS NULL THEN
    RAISE EXCEPTION 'partner export shared organization locks require partner discovery lock first'
      USING ERRCODE = 'P0001';
  END IF;
  FOR org_id IN
    SELECT DISTINCT value AS org_id
      FROM unnest(COALESCE(org_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY org_id
  LOOP
    held_orgs := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_org_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF org_id = ANY(held_orgs) THEN CONTINUE; END IF;
    previous_max := NULLIF(current_setting('breeze.partner_export_org_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND org_id < previous_max THEN
      RAISE EXCEPTION 'partner export organization locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(1000201, hashtext(org_id::text));
    PERFORM set_config('breeze.partner_export_org_lock_max', org_id::text, true);
    PERFORM set_config('breeze.partner_export_org_lock_held', '1', true);
    PERFORM set_config(
      'breeze.partner_export_org_locks',
      array_to_string(array_append(held_orgs, org_id), ','),
      true
    );
  END LOOP;
END;
$$;

-- Hard organization deletion changes discovery visibility. The OLD transition
-- table is the only durable source for both partner and org keys after DELETE.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_organizations_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE partner_ids uuid[]; org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT partner_id ORDER BY partner_id),
         array_agg(DISTINCT id ORDER BY id)
    INTO partner_ids, org_ids
    FROM old_rows;
  PERFORM public.breeze_partner_export_lock_partners_exclusive(partner_ids);
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_organizations_delete ON public.organizations;
CREATE TRIGGER breeze_partner_export_organizations_delete
AFTER DELETE ON public.organizations REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_organizations_delete();

-- Hardware disappearance is a material device change even though the deleted
-- child row can no longer supply an effective timestamp to the LEFT JOIN.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_hardware_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM old_rows;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.devices AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(target.partner_export_updated_at)
    FROM (SELECT DISTINCT device_id, org_id FROM old_rows) AS changed
   WHERE target.id = changed.device_id
     AND target.org_id = changed.org_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_hardware_delete ON public.device_hardware;
CREATE TRIGGER breeze_partner_export_hardware_delete
AFTER DELETE ON public.device_hardware REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_hardware_delete();

-- These columns are database-owned. Direct UPDATE statements cannot replace
-- them. UPDATE OF keeps the guard off heartbeat statements; pg_trigger_depth
-- permits only writes nested inside the trusted material AFTER triggers and
-- prevents the guard from recursively undoing those writes.
CREATE OR REPLACE FUNCTION public.breeze_partner_export_guard_watermark()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.partner_export_updated_at := OLD.partner_export_updated_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_guard_organizations_watermark ON public.organizations;
CREATE TRIGGER breeze_partner_export_guard_organizations_watermark
BEFORE UPDATE OF partner_export_updated_at ON public.organizations
FOR EACH ROW
WHEN (pg_trigger_depth() = 0 AND OLD.partner_export_updated_at IS DISTINCT FROM NEW.partner_export_updated_at)
EXECUTE FUNCTION public.breeze_partner_export_guard_watermark();

DROP TRIGGER IF EXISTS breeze_partner_export_guard_sites_watermark ON public.sites;
CREATE TRIGGER breeze_partner_export_guard_sites_watermark
BEFORE UPDATE OF partner_export_updated_at ON public.sites
FOR EACH ROW
WHEN (pg_trigger_depth() = 0 AND OLD.partner_export_updated_at IS DISTINCT FROM NEW.partner_export_updated_at)
EXECUTE FUNCTION public.breeze_partner_export_guard_watermark();

DROP TRIGGER IF EXISTS breeze_partner_export_guard_devices_watermark ON public.devices;
CREATE TRIGGER breeze_partner_export_guard_devices_watermark
BEFORE UPDATE OF partner_export_updated_at ON public.devices
FOR EACH ROW
WHEN (pg_trigger_depth() = 0 AND OLD.partner_export_updated_at IS DISTINCT FROM NEW.partner_export_updated_at)
EXECUTE FUNCTION public.breeze_partner_export_guard_watermark();

DROP TRIGGER IF EXISTS breeze_partner_export_guard_hardware_watermark ON public.device_hardware;
CREATE TRIGGER breeze_partner_export_guard_hardware_watermark
BEFORE UPDATE OF partner_export_updated_at ON public.device_hardware
FOR EACH ROW
WHEN (pg_trigger_depth() = 0 AND OLD.partner_export_updated_at IS DISTINCT FROM NEW.partner_export_updated_at)
EXECUTE FUNCTION public.breeze_partner_export_guard_watermark();
