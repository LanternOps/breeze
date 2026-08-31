-- S0 Track E: durable PAM ownership evidence makes a device non-transferable.
--
-- The HTTP route performs the same check for a stable conflict response, but
-- this trigger is the authority for every devices.org_id writer. PAM evidence
-- remains source-owned, append-only, and absent from organization-move rewrite
-- discovery. Permanent device deletion and organization erasure are unchanged.

CREATE OR REPLACE FUNCTION public.breeze_guard_pam_device_org_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     AND EXISTS (
       SELECT 1
       FROM public.pam_actuations
       WHERE device_id = OLD.id
         AND org_id = OLD.org_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'devices_pam_history_move_guard',
      MESSAGE = 'device organization move blocked by durable PAM lifecycle evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devices_pam_history_move_guard ON public.devices;
CREATE TRIGGER devices_pam_history_move_guard
  BEFORE UPDATE OF org_id ON public.devices
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_guard_pam_device_org_move();

-- Full current body from 2026-09-06-a-agent-runs-org-immutable.sql, with only
-- the two PAM evidence tables added to the deliberate move-rewrite exclusion.
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
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'pam_actuations',
      'pam_actuation_results'
    )
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
