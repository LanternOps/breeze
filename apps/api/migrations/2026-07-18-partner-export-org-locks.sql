-- Serialize durable partner-export watermarks without putting volatile device
-- telemetry behind one global lock.
--
-- Advisory-lock hierarchy (transaction scoped, always acquired in this order):
--   1. partner discovery/intent: namespace 1000202, hashtext(partner UUID)
--   2. organization material data: namespace 1000201, hashtext(org UUID)
--
-- Arrays are de-duplicated and UUID-sorted before acquisition. Writers take a
-- shared partner intent lock before exclusive org locks; organization
-- discovery/visibility changes take an exclusive partner lock. A transaction
-- guard rejects attempts to acquire a partner lock after any org lock, turning
-- a multi-statement hierarchy inversion into a deterministic error rather than
-- a database deadlock. Hash collisions can only add contention; they cannot
-- grant data access or merge tenant data.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS partner_export_updated_at timestamp(3) NOT NULL DEFAULT now();
ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS partner_export_updated_at timestamp(3) NOT NULL DEFAULT now();
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS partner_export_updated_at timestamp(3) NOT NULL DEFAULT now();
ALTER TABLE public.device_hardware
  ADD COLUMN IF NOT EXISTS partner_export_updated_at timestamp(3) NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.breeze_partner_export_next_timestamp(previous_timestamp timestamp)
RETURNS timestamp
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(
    previous_timestamp + INTERVAL '1 millisecond',
    date_trunc('milliseconds', clock_timestamp()) + INTERVAL '1 millisecond'
  )
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_partners_shared(partner_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  partner_id uuid;
  previous_max uuid;
  held_partners uuid[];
BEGIN
  FOR partner_id IN
    SELECT DISTINCT value AS partner_id
      FROM unnest(COALESCE(partner_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY partner_id
  LOOP
    held_partners := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_partner_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF partner_id = ANY(held_partners) THEN CONTINUE; END IF;
    IF current_setting('breeze.partner_export_org_lock_held', true) = '1' THEN
      RAISE EXCEPTION 'partner export lock hierarchy violation: new partner lock requested after organization lock'
        USING ERRCODE = 'P0001';
    END IF;
    previous_max := NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND partner_id < previous_max THEN
      RAISE EXCEPTION 'partner export partner locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(1000202, hashtext(partner_id::text));
    PERFORM set_config('breeze.partner_export_partner_lock_max', partner_id::text, true);
    PERFORM set_config(
      'breeze.partner_export_partner_locks',
      array_to_string(array_append(held_partners, partner_id), ','),
      true
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_partners_exclusive(partner_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  partner_id uuid;
  previous_max uuid;
  held_partners uuid[];
BEGIN
  IF current_setting('breeze.partner_export_org_lock_held', true) = '1' THEN
    RAISE EXCEPTION 'partner export lock hierarchy violation: partner lock requested after organization lock'
      USING ERRCODE = 'P0001';
  END IF;
  FOR partner_id IN
    SELECT DISTINCT value AS partner_id
      FROM unnest(COALESCE(partner_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY partner_id
  LOOP
    previous_max := NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND partner_id < previous_max THEN
      RAISE EXCEPTION 'partner export partner locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock(1000202, hashtext(partner_id::text));
    PERFORM set_config('breeze.partner_export_partner_lock_max', partner_id::text, true);
    held_partners := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_partner_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF NOT partner_id = ANY(held_partners) THEN
      PERFORM set_config(
        'breeze.partner_export_partner_locks',
        array_to_string(array_append(held_partners, partner_id), ','),
        true
      );
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_orgs_exclusive(org_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id uuid;
  previous_max uuid;
  partner_ids uuid[];
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
    previous_max := NULLIF(current_setting('breeze.partner_export_org_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND org_id < previous_max THEN
      RAISE EXCEPTION 'partner export organization locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock(1000201, hashtext(org_id::text));
    PERFORM set_config('breeze.partner_export_org_lock_max', org_id::text, true);
    PERFORM set_config('breeze.partner_export_org_lock_held', '1', true);
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
    previous_max := NULLIF(current_setting('breeze.partner_export_org_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND org_id < previous_max THEN
      RAISE EXCEPTION 'partner export organization locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(1000201, hashtext(org_id::text));
    PERFORM set_config('breeze.partner_export_org_lock_max', org_id::text, true);
    PERFORM set_config('breeze.partner_export_org_lock_held', '1', true);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_orgs_shared_snapshot(org_ids uuid[])
RETURNS timestamp
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE snapshot_at timestamp;
BEGIN
  PERFORM public.breeze_partner_export_lock_orgs_shared(org_ids);
  snapshot_at := date_trunc('milliseconds', clock_timestamp()) + INTERVAL '1 millisecond';
  WHILE clock_timestamp() < snapshot_at LOOP
    PERFORM pg_sleep(0.0005);
  END LOOP;
  RETURN snapshot_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_organizations_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE partner_ids uuid[]; org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT partner_id ORDER BY partner_id), array_agg(DISTINCT id ORDER BY id)
    INTO partner_ids, org_ids FROM new_rows;
  PERFORM public.breeze_partner_export_lock_partners_exclusive(partner_ids);
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.organizations AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(NULL)
    FROM new_rows AS changed
   WHERE target.id = changed.id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_organizations_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE partner_ids uuid[]; org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT partner_id ORDER BY partner_id)
    INTO partner_ids
    FROM (
      SELECT old_row.partner_id FROM old_rows old_row JOIN new_rows new_row USING (id)
       WHERE ROW(old_row.partner_id, old_row.name, old_row.slug, old_row.type, old_row.status, old_row.deleted_at)
          IS DISTINCT FROM
             ROW(new_row.partner_id, new_row.name, new_row.slug, new_row.type, new_row.status, new_row.deleted_at)
      UNION
      SELECT new_row.partner_id FROM old_rows old_row JOIN new_rows new_row USING (id)
       WHERE ROW(old_row.partner_id, old_row.name, old_row.slug, old_row.type, old_row.status, old_row.deleted_at)
          IS DISTINCT FROM
             ROW(new_row.partner_id, new_row.name, new_row.slug, new_row.type, new_row.status, new_row.deleted_at)
    ) AS affected_partners;
  SELECT array_agg(DISTINCT id ORDER BY id)
    INTO org_ids
    FROM old_rows old_row JOIN new_rows new_row USING (id)
   WHERE ROW(old_row.partner_id, old_row.name, old_row.slug, old_row.type, old_row.status, old_row.deleted_at)
      IS DISTINCT FROM
         ROW(new_row.partner_id, new_row.name, new_row.slug, new_row.type, new_row.status, new_row.deleted_at);
  IF COALESCE(array_length(org_ids, 1), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_partners_exclusive(partner_ids);
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.organizations AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(old_row.partner_export_updated_at)
    FROM old_rows old_row JOIN new_rows new_row USING (id)
   WHERE target.id = new_row.id
     AND ROW(old_row.partner_id, old_row.name, old_row.slug, old_row.type, old_row.status, old_row.deleted_at)
      IS DISTINCT FROM
         ROW(new_row.partner_id, new_row.name, new_row.slug, new_row.type, new_row.status, new_row.deleted_at);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_sites_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM new_rows;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.sites target SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(NULL)
    FROM new_rows changed WHERE target.id = changed.id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_sites_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids
    FROM (
      SELECT old_row.org_id FROM old_rows old_row JOIN new_rows new_row USING (id)
       WHERE ROW(old_row.org_id, old_row.name, old_row.address, old_row.timezone, old_row.contact)
          IS DISTINCT FROM ROW(new_row.org_id, new_row.name, new_row.address, new_row.timezone, new_row.contact)
      UNION
      SELECT new_row.org_id FROM old_rows old_row JOIN new_rows new_row USING (id)
       WHERE ROW(old_row.org_id, old_row.name, old_row.address, old_row.timezone, old_row.contact)
          IS DISTINCT FROM ROW(new_row.org_id, new_row.name, new_row.address, new_row.timezone, new_row.contact)
    ) affected;
  IF COALESCE(array_length(org_ids, 1), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.sites target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(old_row.partner_export_updated_at)
    FROM old_rows old_row JOIN new_rows new_row USING (id)
   WHERE target.id = new_row.id
     AND ROW(old_row.org_id, old_row.name, old_row.address, old_row.timezone, old_row.contact)
      IS DISTINCT FROM ROW(new_row.org_id, new_row.name, new_row.address, new_row.timezone, new_row.contact);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_devices_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM new_rows;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.devices target SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(NULL)
    FROM new_rows changed WHERE target.id = changed.id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_devices_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids
    FROM (
      SELECT old_row.org_id FROM old_rows old_row JOIN new_rows new_row USING (id)
       WHERE ROW(old_row.org_id, old_row.site_id, old_row.hostname, old_row.display_name, old_row.os_type,
                 old_row.device_role, old_row.is_virtual, old_row.virtualization_platform, old_row.os_version,
                 old_row.os_build, old_row.architecture, old_row.enrolled_at, old_row.link_group_id,
                 old_row.link_group_role, old_row.tags, old_row.custom_fields)
          IS DISTINCT FROM
             ROW(new_row.org_id, new_row.site_id, new_row.hostname, new_row.display_name, new_row.os_type,
                 new_row.device_role, new_row.is_virtual, new_row.virtualization_platform, new_row.os_version,
                 new_row.os_build, new_row.architecture, new_row.enrolled_at, new_row.link_group_id,
                 new_row.link_group_role, new_row.tags, new_row.custom_fields)
      UNION
      SELECT new_row.org_id FROM old_rows old_row JOIN new_rows new_row USING (id)
       WHERE ROW(old_row.org_id, old_row.site_id, old_row.hostname, old_row.display_name, old_row.os_type,
                 old_row.device_role, old_row.is_virtual, old_row.virtualization_platform, old_row.os_version,
                 old_row.os_build, old_row.architecture, old_row.enrolled_at, old_row.link_group_id,
                 old_row.link_group_role, old_row.tags, old_row.custom_fields)
          IS DISTINCT FROM
             ROW(new_row.org_id, new_row.site_id, new_row.hostname, new_row.display_name, new_row.os_type,
                 new_row.device_role, new_row.is_virtual, new_row.virtualization_platform, new_row.os_version,
                 new_row.os_build, new_row.architecture, new_row.enrolled_at, new_row.link_group_id,
                 new_row.link_group_role, new_row.tags, new_row.custom_fields)
    ) affected;
  IF COALESCE(array_length(org_ids, 1), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.devices target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(old_row.partner_export_updated_at)
    FROM old_rows old_row JOIN new_rows new_row USING (id)
   WHERE target.id = new_row.id
     AND ROW(old_row.org_id, old_row.site_id, old_row.hostname, old_row.display_name, old_row.os_type,
             old_row.device_role, old_row.is_virtual, old_row.virtualization_platform, old_row.os_version,
             old_row.os_build, old_row.architecture, old_row.enrolled_at, old_row.link_group_id,
             old_row.link_group_role, old_row.tags, old_row.custom_fields)
      IS DISTINCT FROM
         ROW(new_row.org_id, new_row.site_id, new_row.hostname, new_row.display_name, new_row.os_type,
             new_row.device_role, new_row.is_virtual, new_row.virtualization_platform, new_row.os_version,
             new_row.os_build, new_row.architecture, new_row.enrolled_at, new_row.link_group_id,
             new_row.link_group_role, new_row.tags, new_row.custom_fields);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_hardware_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM new_rows;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.device_hardware target SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(NULL)
    FROM new_rows changed WHERE target.device_id = changed.device_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_hardware_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids
    FROM (
      SELECT old_row.org_id FROM old_rows old_row JOIN new_rows new_row USING (device_id)
       WHERE ROW(old_row.org_id, old_row.serial_number, old_row.manufacturer, old_row.model)
          IS DISTINCT FROM ROW(new_row.org_id, new_row.serial_number, new_row.manufacturer, new_row.model)
      UNION
      SELECT new_row.org_id FROM old_rows old_row JOIN new_rows new_row USING (device_id)
       WHERE ROW(old_row.org_id, old_row.serial_number, old_row.manufacturer, old_row.model)
          IS DISTINCT FROM ROW(new_row.org_id, new_row.serial_number, new_row.manufacturer, new_row.model)
    ) affected;
  IF COALESCE(array_length(org_ids, 1), 0) = 0 THEN RETURN NULL; END IF;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.device_hardware target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(old_row.partner_export_updated_at)
    FROM old_rows old_row JOIN new_rows new_row USING (device_id)
   WHERE target.device_id = new_row.device_id
     AND ROW(old_row.org_id, old_row.serial_number, old_row.manufacturer, old_row.model)
      IS DISTINCT FROM ROW(new_row.org_id, new_row.serial_number, new_row.manufacturer, new_row.model);
  RETURN NULL;
END;
$$;

-- Replace the 2026-07-17 membership touch functions. The final material
-- timestamp is assigned only after the exclusive organization lock is held.
CREATE OR REPLACE FUNCTION public.breeze_touch_devices_after_membership_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM new_memberships;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.devices d
     SET updated_at = GREATEST(d.updated_at + INTERVAL '1 millisecond', clock_timestamp()),
         partner_export_updated_at = public.breeze_partner_export_next_timestamp(d.partner_export_updated_at)
    FROM (SELECT DISTINCT device_id, org_id FROM new_memberships) affected
   WHERE d.id = affected.device_id AND d.org_id = affected.org_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_touch_devices_after_membership_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids FROM old_memberships;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.devices d
     SET updated_at = GREATEST(d.updated_at + INTERVAL '1 millisecond', clock_timestamp()),
         partner_export_updated_at = public.breeze_partner_export_next_timestamp(d.partner_export_updated_at)
    FROM (SELECT DISTINCT device_id, org_id FROM old_memberships) affected
   WHERE d.id = affected.device_id AND d.org_id = affected.org_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_touch_devices_after_membership_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT org_id ORDER BY org_id) INTO org_ids
    FROM (SELECT org_id FROM old_memberships UNION SELECT org_id FROM new_memberships) affected_orgs;
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(org_ids);
  UPDATE public.devices d
     SET updated_at = GREATEST(d.updated_at + INTERVAL '1 millisecond', clock_timestamp()),
         partner_export_updated_at = public.breeze_partner_export_next_timestamp(d.partner_export_updated_at)
    FROM (
      SELECT DISTINCT device_id, org_id
      FROM (SELECT device_id, org_id FROM old_memberships UNION SELECT device_id, org_id FROM new_memberships) changed
    ) affected
   WHERE d.id = affected.device_id AND d.org_id = affected.org_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_export_organizations_insert ON public.organizations;
CREATE TRIGGER breeze_partner_export_organizations_insert
AFTER INSERT ON public.organizations REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_organizations_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_organizations_update ON public.organizations;
CREATE TRIGGER breeze_partner_export_organizations_update
AFTER UPDATE ON public.organizations REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_organizations_update();

DROP TRIGGER IF EXISTS breeze_partner_export_sites_insert ON public.sites;
CREATE TRIGGER breeze_partner_export_sites_insert
AFTER INSERT ON public.sites REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_sites_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_sites_update ON public.sites;
CREATE TRIGGER breeze_partner_export_sites_update
AFTER UPDATE ON public.sites REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_sites_update();

DROP TRIGGER IF EXISTS breeze_partner_export_devices_insert ON public.devices;
CREATE TRIGGER breeze_partner_export_devices_insert
AFTER INSERT ON public.devices REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_devices_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_devices_update ON public.devices;
CREATE TRIGGER breeze_partner_export_devices_update
AFTER UPDATE ON public.devices REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_devices_update();

DROP TRIGGER IF EXISTS breeze_partner_export_hardware_insert ON public.device_hardware;
CREATE TRIGGER breeze_partner_export_hardware_insert
AFTER INSERT ON public.device_hardware REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_hardware_insert();
DROP TRIGGER IF EXISTS breeze_partner_export_hardware_update ON public.device_hardware;
CREATE TRIGGER breeze_partner_export_hardware_update
AFTER UPDATE ON public.device_hardware REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.breeze_partner_export_hardware_update();
