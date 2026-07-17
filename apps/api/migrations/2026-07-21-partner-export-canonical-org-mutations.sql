-- Permit legitimate multi-statement organization mutations without weakening
-- the monotonic lock rule used by ordinary shared-partner material writers.
--
-- Organization visibility mutations hold the partner discovery key EXCLUSIVE.
-- Once that exclusive key is held, no reader or material writer for the same
-- partner can hold/reach an org key, so acquiring another org for that already
-- exclusive partner cannot form an org-order deadlock. New partner keys after
-- any org lock and descending org keys under only shared partner intent remain
-- deterministic P0001 errors.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_partners_exclusive(partner_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  partner_id uuid;
  previous_max uuid;
  held_partners uuid[];
  held_exclusive_partners uuid[];
BEGIN
  FOR partner_id IN
    SELECT DISTINCT value AS partner_id
      FROM unnest(COALESCE(partner_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY partner_id
  LOOP
    held_exclusive_partners := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_exclusive_partner_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF partner_id = ANY(held_exclusive_partners) THEN CONTINUE; END IF;

    IF current_setting('breeze.partner_export_org_lock_held', true) = '1' THEN
      RAISE EXCEPTION 'partner export lock hierarchy violation: new partner lock requested after organization lock'
        USING ERRCODE = 'P0001';
    END IF;
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
    PERFORM set_config(
      'breeze.partner_export_exclusive_partner_locks',
      array_to_string(array_append(held_exclusive_partners, partner_id), ','),
      true
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_orgs_under_exclusive_partners(
  org_ids uuid[],
  partner_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  partner_id uuid;
  org_id uuid;
  previous_max uuid;
  held_orgs uuid[];
  held_exclusive_partners uuid[];
BEGIN
  IF COALESCE(array_length(org_ids, 1), 0) > 0
     AND COALESCE(array_length(partner_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'partner export organization mutation requires a non-empty partner lock set'
      USING ERRCODE = 'P0001';
  END IF;
  held_exclusive_partners := COALESCE(
    string_to_array(NULLIF(current_setting('breeze.partner_export_exclusive_partner_locks', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
  FOR partner_id IN
    SELECT DISTINCT value
      FROM unnest(COALESCE(partner_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY value
  LOOP
    IF NOT partner_id = ANY(held_exclusive_partners) THEN
      RAISE EXCEPTION 'partner export organization mutation requires its partner exclusive lock first'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  FOR org_id IN
    SELECT DISTINCT value
      FROM unnest(COALESCE(org_ids, ARRAY[]::uuid[])) AS ids(value)
     WHERE value IS NOT NULL
     ORDER BY value
  LOOP
    held_orgs := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_org_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF org_id = ANY(held_orgs) THEN CONTINUE; END IF;

    PERFORM pg_advisory_xact_lock(1000201, hashtext(org_id::text));
    previous_max := NULLIF(current_setting('breeze.partner_export_org_lock_max', true), '')::uuid;
    IF previous_max IS NULL OR org_id > previous_max THEN
      PERFORM set_config('breeze.partner_export_org_lock_max', org_id::text, true);
    END IF;
    PERFORM set_config('breeze.partner_export_org_lock_held', '1', true);
    PERFORM set_config(
      'breeze.partner_export_org_locks',
      array_to_string(array_append(held_orgs, org_id), ','),
      true
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_organizations_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE partner_ids uuid[]; org_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT partner_id ORDER BY partner_id),
         array_agg(DISTINCT id ORDER BY id)
    INTO partner_ids, org_ids FROM new_rows;
  PERFORM public.breeze_partner_export_lock_partners_exclusive(partner_ids);
  PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(org_ids, partner_ids);
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
  PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(org_ids, partner_ids);
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
  PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(org_ids, partner_ids);
  RETURN NULL;
END;
$$;
