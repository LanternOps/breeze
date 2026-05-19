-- Issue #750: device-child tables denormalize devices.org_id for the RLS
-- hot path. Nothing kept that copy in sync when a device moved orgs, so
-- child rows kept a stale org_id. On the agent inventory upserts
-- (device_hardware, device_patches, device_registry_state,
-- device_config_state, security_status — their ON CONFLICT ... DO UPDATE
-- set-blocks don't refresh org_id) the UPDATE policy's USING expression
-- (breeze_has_org_access(org_id)) is evaluated against the *existing*
-- stale row under the agent's now-current-org scope, returns FALSE, and
-- the write fails: "new row violates row-level security policy (USING
-- expression)" — ~144/hr on a live fleet, silently dropping inventory.
--
-- The drift had no single app entrypoint (there is no first-class
-- "move device to org" handler; it came from ops/direct SQL), so an
-- app-layer cascade alone could be bypassed. Fix it at the DB layer so
-- it holds regardless of which path mutates devices.org_id:
--
--   1. A SECURITY DEFINER trigger on devices (AFTER UPDATE OF org_id)
--      that cascades the new org_id to every device-child table,
--      discovered dynamically so a newly-added denormalized table can't
--      silently reintroduce the drift.
--   2. A one-time backfill realigning all existing drift across every
--      device-child table (the prod hotfix only repaired the 2 hot
--      tables; the other ~9 were latent read-time RLS bombs).
--
-- Idempotent: CREATE OR REPLACE / DROP TRIGGER IF EXISTS; the backfill
-- only touches mismatched rows, so re-applying is a no-op.

-- Shared discovery: ordinary public tables (not devices itself) that
-- carry BOTH a uuid device_id and a uuid org_id column. uuid-typed guard
-- avoids touching any unrelated column that happens to share a name.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;

-- Trigger function. SECURITY DEFINER so the cascade runs with the
-- migration/owner role's privileges and is not itself blocked by the
-- child tables' org RLS (the same privilege the one-time backfill below
-- relies on). search_path pinned for SECURITY DEFINER safety; every
-- table reference is schema-qualified regardless.
CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  child_table text;
BEGIN
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;

DROP TRIGGER IF EXISTS breeze_cascade_device_org_id ON public.devices;
CREATE TRIGGER breeze_cascade_device_org_id
  AFTER UPDATE OF org_id ON public.devices
  FOR EACH ROW
  WHEN (NEW.org_id IS DISTINCT FROM OLD.org_id)
  EXECUTE FUNCTION public.breeze_cascade_device_org_id();

-- One-time backfill: realign every existing drifted device-child row to
-- its device's current org. Runs as the migration role (RLS-exempt),
-- covering ALL device-child tables, not just the two that error at
-- ingest. Idempotent (only mismatched rows are touched).
DO $$
DECLARE
  child_table text;
  fixed bigint;
  total bigint := 0;
BEGIN
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I AS c SET org_id = d.org_id FROM public.devices d '
      'WHERE c.device_id = d.id AND c.org_id IS DISTINCT FROM d.org_id',
      child_table
    );
    GET DIAGNOSTICS fixed = ROW_COUNT;
    IF fixed > 0 THEN
      RAISE NOTICE 'device-child org_id backfill: % rows realigned in %', fixed, child_table;
      total := total + fixed;
    END IF;
  END LOOP;
  RAISE NOTICE 'device-child org_id backfill complete: % rows realigned total', total;
END;
$$;
