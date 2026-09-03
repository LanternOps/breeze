-- #4644 — mirror moveOrg's ticket_comments.agent_run_id reverse-pointer
-- detach into breeze_cascade_device_org_id().
--
-- `apps/api/src/routes/devices/moveOrg.ts` nulls the reverse pointer
-- ticket_comments.agent_run_id for every comment whose ticket is bound to the
-- moving device:
--
--     UPDATE ticket_comments SET agent_run_id = NULL
--       WHERE agent_run_id IS NOT NULL
--         AND ticket_id IN (SELECT id FROM tickets WHERE device_id = <deviceId>)
--
-- The DB-side cascade — breeze_cascade_device_org_id(), the path taken by
-- direct-SQL / non-route callers such as orgMerge's `devices` repoint — never
-- mirrored it. `ticket_comments` has no org_id (child-via-parent tenancy
-- through `tickets`); `tickets` IS returned by
-- breeze_device_child_orgid_tables(), so a ticket bound to the moved device is
-- re-stamped to the target org by the generic loop below and every comment on
-- it travels along, while the run it names stays with the SOURCE org
-- (owner decision 2026-08-23: agent-run history never follows a move). A
-- retained agent_run_id then names a source-org run from a target-org row —
-- the same reverse-pointer class #3828 closed for
-- metric_anomaly_incidents.agent_run_id and #4215 closed for
-- ai_agent_runs.ticket_id, both of which were carried the same way (route
-- statement first, this function second) until mirrored here. #4642 already
-- closed the same column on the TICKET axis (moveTicketOrg,
-- ticketService.ts); this closes the DEVICE axis's DB-side cascade to match
-- the route statement added alongside this migration.
--
-- Placement: immediately after the metric_anomaly_incidents reverse pointer —
-- the same reverse-pointer class, same "before the generic restamp loop"
-- ordering rationale — and BEFORE the action_intents scope tombstone and the
-- tickets requester detach, matching moveOrg.ts's own statement order.
-- Ordering does not actually change the result here: the join key is
-- tickets.device_id, which the generic loop never touches (it only rewrites
-- org_id), so the subselect resolves identically pre- or post-restamp. Placed
-- with the reverse pointers purely for readability.
--
-- Only the cross-org link is dropped: origin_principal_kind (what the
-- helpdesk loop guard actually keys on) is untouched, and nulling drops the
-- row out of the partial unique index ticket_comments_one_ai_note_per_run_uq
-- (predicate requires agent_run_id IS NOT NULL), so it can never collide.
--
-- Severity today: latent, not live — nothing writes ticket_comments.agent_run_id
-- yet (the autonomous-note lane is deferred; see the column comment in
-- db/schema/portal.ts), so no production row carries a value on either axis.
-- The point of fixing it now is to have the contract in place before that lane
-- ships.
--
-- NO HISTORICAL BACKFILL, for the same reason 2026-09-29's header gives: doing
-- a bare cleanup UPDATE here — outside any request/access context — would run
-- under whatever GUCs the migration runner happens to hold, and ticket_comments'
-- UPDATE policy (breeze_ticket_parent_update, an EXISTS join on the parent
-- ticket's org) is not guaranteed to pass. Since nothing writes this column
-- yet, there is nothing to backfill: any pre-existing NULL is already correct,
-- and no non-NULL row can exist to be stale.
--
-- Full function body copied verbatim from
-- 2026-10-06-124500-cascade-device-org-move-intent-scope.sql (the newest
-- definition; no later migration replaces this function) with only the
-- ticket_comments statement added. CREATE OR REPLACE is idempotent by
-- construction — re-applying this file re-installs the same body. The trigger
-- itself (breeze_cascade_device_org_id ON devices, AFTER UPDATE OF org_id ...
-- WHEN NEW.org_id IS DISTINCT FROM OLD.org_id) is unchanged and is NOT
-- redeclared here.
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
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;
