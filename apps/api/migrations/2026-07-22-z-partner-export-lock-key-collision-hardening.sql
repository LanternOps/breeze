-- Advisory partner locks use a 32-bit hash of a 128-bit UUID. Track the
-- physical advisory key as well as the logical UUID so a hash collision cannot
-- hide a shared-to-exclusive upgrade and reintroduce a database deadlock.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_lock_partners_shared(partner_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  partner_id uuid;
  partner_lock_key integer;
  previous_max uuid;
  held_partners uuid[];
  held_partner_lock_keys integer[];
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

    partner_lock_key := hashtext(partner_id::text);
    held_partner_lock_keys := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_partner_lock_keys', true), ''), ',')::integer[],
      ARRAY[]::integer[]
    );

    IF NOT partner_lock_key = ANY(held_partner_lock_keys) THEN
      IF current_setting('breeze.partner_export_org_lock_held', true) = '1' THEN
        RAISE EXCEPTION 'partner export lock hierarchy violation: new partner lock requested after organization lock'
          USING ERRCODE = 'P0001';
      END IF;
      previous_max := NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '')::uuid;
      IF previous_max IS NOT NULL AND partner_id < previous_max THEN
        RAISE EXCEPTION 'partner export partner locks must be acquired in ascending UUID order'
          USING ERRCODE = 'P0001';
      END IF;

      PERFORM pg_advisory_xact_lock_shared(1000202, partner_lock_key);
      PERFORM set_config(
        'breeze.partner_export_partner_lock_keys',
        array_to_string(array_append(held_partner_lock_keys, partner_lock_key), ','),
        true
      );
    END IF;

    previous_max := NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '')::uuid;
    IF previous_max IS NULL OR partner_id > previous_max THEN
      PERFORM set_config('breeze.partner_export_partner_lock_max', partner_id::text, true);
    END IF;
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
  partner_lock_key integer;
  previous_max uuid;
  held_partners uuid[];
  held_exclusive_partners uuid[];
  held_partner_lock_keys integer[];
  held_exclusive_partner_lock_keys integer[];
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
    held_exclusive_partners := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_exclusive_partner_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF partner_id = ANY(held_exclusive_partners) THEN CONTINUE; END IF;

    partner_lock_key := hashtext(partner_id::text);
    held_partner_lock_keys := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_partner_lock_keys', true), ''), ',')::integer[],
      ARRAY[]::integer[]
    );
    held_exclusive_partner_lock_keys := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_exclusive_partner_lock_keys', true), ''), ',')::integer[],
      ARRAY[]::integer[]
    );

    IF partner_lock_key = ANY(held_exclusive_partner_lock_keys) THEN
      -- A colliding UUID maps to an exclusive key already owned by this
      -- transaction. Record its logical ownership without reacquiring it.
      PERFORM set_config(
        'breeze.partner_export_partner_locks',
        array_to_string(array_append(held_partners, partner_id), ','),
        true
      );
      PERFORM set_config(
        'breeze.partner_export_exclusive_partner_locks',
        array_to_string(array_append(held_exclusive_partners, partner_id), ','),
        true
      );
      previous_max := NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '')::uuid;
      IF previous_max IS NULL OR partner_id > previous_max THEN
        PERFORM set_config('breeze.partner_export_partner_lock_max', partner_id::text, true);
      END IF;
      CONTINUE;
    END IF;

    IF partner_lock_key = ANY(held_partner_lock_keys) THEN
      RAISE EXCEPTION 'partner export shared partner lock keys cannot be upgraded to exclusive'
        USING ERRCODE = 'P0001';
    END IF;
    IF current_setting('breeze.partner_export_org_lock_held', true) = '1' THEN
      RAISE EXCEPTION 'partner export lock hierarchy violation: new partner lock requested after organization lock'
        USING ERRCODE = 'P0001';
    END IF;
    previous_max := NULLIF(current_setting('breeze.partner_export_partner_lock_max', true), '')::uuid;
    IF previous_max IS NOT NULL AND partner_id < previous_max THEN
      RAISE EXCEPTION 'partner export partner locks must be acquired in ascending UUID order'
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(1000202, partner_lock_key);
    PERFORM set_config('breeze.partner_export_partner_lock_max', partner_id::text, true);
    PERFORM set_config(
      'breeze.partner_export_partner_lock_keys',
      array_to_string(array_append(held_partner_lock_keys, partner_lock_key), ','),
      true
    );
    PERFORM set_config(
      'breeze.partner_export_exclusive_partner_lock_keys',
      array_to_string(array_append(held_exclusive_partner_lock_keys, partner_lock_key), ','),
      true
    );
    PERFORM set_config(
      'breeze.partner_export_partner_locks',
      array_to_string(array_append(held_partners, partner_id), ','),
      true
    );
    PERFORM set_config(
      'breeze.partner_export_exclusive_partner_locks',
      array_to_string(array_append(held_exclusive_partners, partner_id), ','),
      true
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[]) FROM breeze_app;
