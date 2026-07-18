-- Harden the partner-export advisory-lock foundation without changing the
-- canonical organization cleanup behavior introduced on 2026-07-21.
--
-- PostgreSQL advisory locks do not provide a safe shared-to-exclusive upgrade:
-- two transactions that both hold the shared key can deadlock while upgrading.
-- Reject that state from the transaction-local lock ledger before asking
-- PostgreSQL for an exclusive key. Also keep organization mutation helpers
-- private and verify live org/partner ownership before taking an org lock.

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
    held_partners := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_partner_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    held_exclusive_partners := COALESCE(
      string_to_array(NULLIF(current_setting('breeze.partner_export_exclusive_partner_locks', true), ''), ',')::uuid[],
      ARRAY[]::uuid[]
    );
    IF partner_id = ANY(held_exclusive_partners) THEN CONTINUE; END IF;
    IF partner_id = ANY(held_partners) THEN
      RAISE EXCEPTION 'partner export shared partner locks cannot be upgraded to exclusive'
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

    PERFORM pg_advisory_xact_lock(1000202, hashtext(partner_id::text));
    PERFORM set_config('breeze.partner_export_partner_lock_max', partner_id::text, true);
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

-- Ordinary material writers use this helper as the invoking breeze_app role.
-- Require every requested org to resolve through forced RLS before acquiring
-- any advisory lock; previously an invisible/unknown org skipped partner
-- discovery but still acquired its org key.
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
  requested_org_ids uuid[];
  resolved_org_count bigint;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value), ARRAY[]::uuid[])
    INTO requested_org_ids
    FROM unnest(COALESCE(org_ids, ARRAY[]::uuid[])) AS ids(value)
   WHERE value IS NOT NULL;

  SELECT COALESCE(array_agg(DISTINCT o.partner_id ORDER BY o.partner_id), ARRAY[]::uuid[]),
         count(DISTINCT o.id)
    INTO partner_ids, resolved_org_count
    FROM public.organizations AS o
   WHERE o.id = ANY(requested_org_ids);

  IF resolved_org_count <> cardinality(requested_org_ids) THEN
    RAISE EXCEPTION 'partner export organization lock requested for an unknown or inaccessible organization'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.breeze_partner_export_lock_partners_shared(partner_ids);

  FOREACH org_id IN ARRAY requested_org_ids
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

-- This helper is reachable only from the organization transition-table
-- triggers below. For INSERT/UPDATE, verify each live organization maps to one
-- of the transition-derived partner IDs. DELETE rows no longer exist here, so
-- their pairing remains sourced exclusively from OLD TABLE and the helper is
-- kept private from breeze_app.
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
  IF EXISTS (
    SELECT 1
      FROM public.organizations AS organization
     WHERE organization.id = ANY(COALESCE(org_ids, ARRAY[]::uuid[]))
       AND NOT EXISTS (
         SELECT 1
           FROM unnest(COALESCE(partner_ids, ARRAY[]::uuid[])) AS supplied_partner(id)
          WHERE supplied_partner.id = organization.partner_id
       )
  ) THEN
    RAISE EXCEPTION 'partner export organization mutation supplied an unrelated partner lock set'
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

-- Organization statements are already constrained by forced RLS. Definer mode
-- is limited to these transition-table trigger functions so they can invoke
-- the private mutation lock helpers; their UPDATE targets remain restricted to
-- IDs supplied by NEW/OLD TABLE from the authorized statement.
ALTER FUNCTION public.breeze_partner_export_organizations_insert() SECURITY DEFINER;
ALTER FUNCTION public.breeze_partner_export_organizations_insert()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.breeze_partner_export_organizations_update() SECURITY DEFINER;
ALTER FUNCTION public.breeze_partner_export_organizations_update()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.breeze_partner_export_organizations_delete() SECURITY DEFINER;
ALTER FUNCTION public.breeze_partner_export_organizations_delete()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[]) FROM breeze_app;
REVOKE ALL ON FUNCTION public.breeze_partner_export_lock_orgs_under_exclusive_partners(uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_lock_orgs_under_exclusive_partners(uuid[], uuid[]) FROM breeze_app;
REVOKE ALL ON FUNCTION public.breeze_partner_export_organizations_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_organizations_insert() FROM breeze_app;
REVOKE ALL ON FUNCTION public.breeze_partner_export_organizations_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_organizations_update() FROM breeze_app;
REVOKE ALL ON FUNCTION public.breeze_partner_export_organizations_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_organizations_delete() FROM breeze_app;
