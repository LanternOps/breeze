-- #4215 — detach ai_agent_runs.ticket_id on a device org-move.
--
-- breeze_cascade_device_org_id() (last replaced in
-- 2026-09-20-ai-agents-anomaly-pilot.sql) severs the moved device's
-- ai_agent_runs lineage pointers with a single `WHERE device_id = NEW.id`
-- statement. That WHERE can never reach `ticket_id`: ticket-triggered runs are
-- device-less (trigger_kind 'ticket' stamps ticket_id and leaves device_id
-- NULL), yet `tickets` IS returned by breeze_device_child_orgid_tables(), so a
-- ticket bound to the moved device is re-stamped to the destination org by the
-- generic loop below while the run — whose org_id deliberately stays with the
-- SOURCE org (owner decision 2026-08-23) — keeps pointing at a now-foreign
-- ticket. Same cross-tenant-pointer class that #3828 fixed for
-- anomaly_incident_id, recorded since then as a known gap in
-- moveOrg.coverage.test.ts.
--
-- Fix: a second, ticket-keyed detach using the same
-- `ticket_id IN (SELECT id FROM tickets WHERE device_id = ...)` join the
-- route's ticket_attachments / time_entries / ticket_parts org rewrites
-- already use. It reaches both the device-less ticket runs and device runs on
-- the same ticket, and touches nothing whose ticket stays behind in the source
-- org. Placed BEFORE the generic loop so both sides of the statement are still
-- read pre-restamp, matching the metric_anomaly_incidents reverse pointer.
--
-- Mirrors the identical pair of statements in
-- apps/api/src/routes/devices/moveOrg.ts (the route path); this function is
-- the DB-side path for direct-SQL/non-route callers such as orgMerge. The two
-- sites are held in sync by moveOrg.coverage.test.ts's "ai_agent_runs
-- run-lineage detach coverage" block, which derives the expected column set
-- from the ai_agent_runs schema's own FK columns and resolves the newest
-- migration defining this function dynamically.
--
-- Full function body copied verbatim from 2026-09-20-ai-agents-anomaly-pilot
-- (the newest definition; no later migration replaces this function) with only
-- the ticket-keyed UPDATE added. CREATE OR REPLACE is idempotent by
-- construction — re-applying this file re-installs the same body.
CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  child_table text;
BEGIN
  -- Agent-run history stays with the SOURCE org (owner decision 2026-08-23):
  -- sever the moved device's lineage links instead of re-stamping org_id.
  UPDATE public.ai_agent_runs
    SET device_id = NULL, alert_id = NULL, session_id = NULL, anomaly_incident_id = NULL
    WHERE device_id = NEW.id;
  -- ticket_id is device-lineage too, but unreachable from `WHERE device_id`:
  -- ticket-triggered runs carry a ticket_id with a NULL device_id. Key off the
  -- ticket's device_id instead (#4215).
  UPDATE public.ai_agent_runs
    SET ticket_id = NULL
    WHERE ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  -- Reverse pointer: the incident's back-link to the (now-detached) run must
  -- not keep naming a source-org run once the incident itself is re-stamped
  -- to the destination org by the generic loop below.
  UPDATE public.metric_anomaly_incidents
    SET agent_run_id = NULL
    WHERE device_id = NEW.id;
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;

-- Deliberately NO historical backfill of already-stale ticket_id values.
-- ai_agent_runs is FORCE ROW LEVEL SECURITY, so a bare `UPDATE ... WHERE
-- r.org_id IS DISTINCT FROM t.org_id` here would be subject to policy even for
-- the table owner and, run without a breeze_* access context, would match zero
-- rows — a cleanup that silently reports "0 cleaned" while leaving the rows in
-- place is worse than none (it destroys the forensic signal a real count would
-- carry). Any pre-fix rows are a read-only lineage pointer on run history the
-- source org already owned; if a sweep is wanted it belongs in a scripted
-- backfill run under a known access context, not in this migration.
