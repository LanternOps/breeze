-- #4792 — mirror moveOrg's action_intents.scope_ticket_id tombstone into
-- breeze_cascade_device_org_id().
--
-- Found while fixing #4454/#4790, which mirrored the scope_device_id
-- tombstone into this same function. The TICKET axis of the same typed
-- target scope has a worse version of the same gap, and it was missing from
-- BOTH sites (the route and this trigger) until now — not just the trigger.
--
-- `tickets` IS returned by breeze_device_child_orgid_tables(), so a device
-- org-move re-stamps tickets.org_id for every ticket bound to the moved
-- device via the generic loop below. `action_intents.org_id` is immutable
-- (action_intents_block_content_update() raises on any change to it).
-- `action_intents_scope_ticket_org_fk`
-- (migrations/2026-09-25-ai-agents-ticket-triage.sql:216-219) is:
--
--   FOREIGN KEY (scope_ticket_id, org_id) REFERENCES tickets (id, org_id)
--     ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE
--
-- No ON UPDATE clause, so it defaults to NO ACTION and is checked at the end
-- of the statement that fires it (the generic loop's tickets UPDATE — the
-- FK is not named in this transaction's SET CONSTRAINTS, and this function
-- runs under whatever constraint mode the calling statement's transaction
-- is in). Re-stamping tickets.org_id therefore leaves any intent scoped to
-- that ticket holding a pair (scope_ticket_id, OLD org_id) that no longer
-- exists in `tickets` — a 23503 that aborts the whole device move.
--
-- Unlike the scope_device_id tombstone (#4454) this reaches intents of
-- EVERY status, not just live ones: the FK does not care about `status`, and
-- a terminal-status intent still carries the same composite pair and would
-- still 23503 the moment the ticket's org_id changes. Same reasoning
-- ticketService.ts's moveTicketOrg already documents for the ticket-level
-- move (its own identical detach, all statuses, run before the ticket
-- UPDATE that would otherwise trip this same constraint).
--
-- The immutability trigger (action_intents_block_content_update(), see
-- 2026-09-25-ai-agents-ticket-triage.sql) permits exactly this non-null ->
-- NULL transition for scope_ticket_id (mirroring the scope_device_id
-- carve-out it already had), so this UPDATE is the tombstone path, not a
-- bypass.
--
-- Placement: immediately after the scope_device_id tombstone and the
-- tickets requester-contact detach, and BEFORE the generic
-- breeze_device_child_orgid_tables() re-stamp loop — same "before the
-- statement that trips the constraint" ordering the requester-contact
-- detach already requires, matching moveOrg.ts's own statement order.
--
-- No historical backfill: same reasoning as the scope_device_id tombstone's
-- migration header (2026-10-06-124500) — action_intents is FORCE ROW LEVEL
-- SECURITY, so a contextless migration-time cleanup would match zero rows on
-- a managed Postgres and report a silent "0 cleaned". Unlike scope_device_id
-- this gap is a hard abort (23503), not a silently-stale pointer, so there is
-- nothing pre-existing to clean up: a device org-move carrying a
-- ticket-scoped intent could not have succeeded before this fix, on either
-- the route (which never had this statement either) or this trigger.
--
-- Full function body copied verbatim from
-- 2026-10-08-100500-detach-ticket-comment-runs-on-device-org-move.sql (the
-- newest definition; no later migration replaces this function) with only
-- the action_intents.scope_ticket_id statement added. CREATE OR REPLACE is
-- idempotent by construction — re-applying this file re-installs the same
-- body. The trigger itself (breeze_cascade_device_org_id ON devices, AFTER
-- UPDATE OF org_id ... WHEN NEW.org_id IS DISTINCT FROM OLD.org_id) is
-- unchanged and is NOT redeclared here.
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
  -- Reverse pointer: ticket_comments.agent_run_id (#4644). ticket_comments has
  -- no org_id of its own (child-via-parent tenancy through tickets), so a
  -- comment on a ticket bound to this device travels to the target org via the
  -- generic loop below while the run it names stays with the SOURCE org —
  -- same class as the metric_anomaly_incidents reverse pointer above, and the
  -- device-axis mirror of moveTicketOrg's ticket_comments detach
  -- (ticketService.ts, #4642) on the ticket axis.
  UPDATE public.ticket_comments
    SET agent_run_id = NULL
    WHERE agent_run_id IS NOT NULL
      AND ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  -- Typed target scope of a LIVE intent must not keep naming a device that has
  -- just left the intent's org (#4454). Mirrors moveOrg.ts; see the header for
  -- the live-status gate, the immutability-trigger transition, and why this one
  -- takes no merge fence.
  UPDATE public.action_intents
    SET scope_device_id = NULL
    WHERE scope_device_id = NEW.id
      AND status IN ('pending_approval', 'approved', 'executing');
  -- The requester CONTACT is org-pinned and does not travel with the device
  -- (#3258 W03). Skipped while the source org is fenced for a merge, where the
  -- contact moves to the survivor alongside the ticket — see the header of
  -- 2026-10-04-100000-ticket-requester-contact.sql.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    UPDATE public.tickets
      SET requester_contact_id = NULL
      WHERE device_id = NEW.id
        AND requester_contact_id IS NOT NULL
        AND org_id IS DISTINCT FROM NEW.org_id;
  END IF;
  -- Typed target scope of an intent scoped to a TICKET bound to this device
  -- (#4792) must not keep naming a (ticket, OLD org_id) pair once the ticket
  -- is re-stamped to the destination org by the generic loop below — every
  -- status, not just live ones, since action_intents_scope_ticket_org_fk does
  -- not gate on status and would 23503 the loop's own tickets UPDATE
  -- otherwise. See this migration's header for the full mechanism; mirrors
  -- moveOrg.ts and moveTicketOrg (ticketService.ts). Placed after the
  -- requester-contact detach immediately above (order between the two is not
  -- itself load-bearing — they touch disjoint tables — but this makes the
  -- trigger's statement order match moveOrg.ts's exactly, not just
  -- "before the loop").
  UPDATE public.action_intents
    SET scope_ticket_id = NULL
    WHERE scope_ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;
