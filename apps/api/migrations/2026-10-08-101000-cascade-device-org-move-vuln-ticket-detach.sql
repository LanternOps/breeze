-- #4645 — device_vulnerabilities.ticket_id keeps naming a ticket that moved
-- to another org (or was left behind by a device move). Decision made in the
-- issue: option A, mirroring #4642's precedent (null the FK on divergence,
-- same as every other stale-pointer detach breeze_cascade_device_org_id()
-- already performs) and covering BOTH axes:
--
--   1. TICKET axis (services/ticketService.ts's moveTicketOrg): a finding's
--      remediation ticket moves to another org via moveTicketOrg while the
--      finding (device_vulnerabilities row) stays behind with its device —
--      device_vulnerabilities.org_id is the DEVICE's org and is never
--      touched by a ticket move. Fixed alongside this migration, in the same
--      PR, by a `device_vulnerabilities.ticket_id = NULL` statement in
--      moveTicketOrg itself (not this trigger — moveTicketOrg has no
--      corresponding SQL trigger the way the device axis does).
--
--   2. DEVICE axis (this migration): the reverse direction. `device_id` FK
--      to `devices.id`, plain (not composite), `org_id` uuid NOT NULL
--      (`references(() => organizations.id)`, no onDelete clause — a bare FK,
--      distinct from `ticket_id`'s `ON DELETE SET NULL`).
--      `device_vulnerabilities` IS in getDeviceOrgDenormalizedTables() /
--      breeze_device_child_orgid_tables(), so the generic loop below already
--      re-stamps a finding's org_id to the device's new (target) org — the
--      finding always travels with its device. Its remediation ticket does
--      NOT: `POST /vulnerabilities/tickets` (routes/vulnerabilities.ts)
--      creates the ticket org-scoped only and never sets `tickets.device_id`,
--      so the `tickets` UPDATE inside this same generic loop (device-bound
--      tickets only) never reaches it — the ticket stays in whatever org it
--      was created in. Once the finding's org_id is the target org, a
--      ticket_id still naming a SOURCE-org ticket resolves to nothing under
--      RLS for any caller in the target org (a dead `/tickets#...` link
--      client-side — CveDrawer/SoftwareGroupDrawer render it; nothing
--      server-side dereferences the column).
--
-- `ticket_id` is a PLAIN single-column FK (not the composite
-- `(x, org_id) -> tickets(id, org_id)` shape the action_intents/tickets
-- tombstones above exist to satisfy), so this statement can never 23503
-- either way — unlike those, it is not a correctness-of-transaction
-- requirement, only a tenancy-hygiene one. Placed AFTER the generic
-- `breeze_device_child_orgid_tables()` loop (not before, and not mixed in
-- with the pre-loop tombstones above), specifically so it can compare
-- against the referenced ticket's ACTUAL (post-restamp) org: a ticket that
-- happens to be bound to this same device (`tickets.device_id = NEW.id`) is
-- ALSO re-stamped to the target org by that same loop, and by the time this
-- statement runs its org_id already matches — so the link is correctly left
-- alone. Checking before the loop would see that ticket's stale SOURCE org
-- and wrongly null a link that is about to become valid.
--
-- No historical backfill: unlike the scope_device_id/scope_ticket_id
-- tombstones above, a stale device_vulnerabilities.ticket_id is not a hard
-- abort (this FK cannot 23503), so pre-existing rows are not blocking
-- anything — they are exactly the mild, already-shipped symptom (#4524
-- sweep) this issue reports. Bulk-correcting them retroactively is a
-- separate, deliberate backfill decision (RLS/system-context concerns per
-- CLAUDE.md), not something to fold silently into a trigger-definition
-- migration.
--
-- Full function body copied verbatim from
-- 2026-10-08-100900-cascade-device-org-move-ticket-scope.sql (the newest
-- definition; no later migration replaces this function) with only the
-- device_vulnerabilities.ticket_id statement added, after the generic loop.
-- CREATE OR REPLACE is idempotent by construction — re-applying this file
-- re-installs the same body. The trigger itself (breeze_cascade_device_org_id
-- ON devices, AFTER UPDATE OF org_id ... WHEN NEW.org_id IS DISTINCT FROM
-- OLD.org_id) is unchanged and is NOT redeclared here.
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
  -- device_vulnerabilities.ticket_id (#4645): must run AFTER the generic loop
  -- above, not before — see this migration's header for why the ordering is
  -- load-bearing here (it is not for any of the tombstones above, which all
  -- run before the loop precisely because THEIR FK would 23503 otherwise).
  -- device_vulnerabilities.org_id has just been re-stamped to NEW.org_id by
  -- that loop (device_vulnerabilities IS a member of
  -- breeze_device_child_orgid_tables()), so a finding's ticket_id is
  -- compared against the ticket's own (possibly also just re-stamped) org_id
  -- rather than the finding's — a ticket bound to this same device was ALSO
  -- just moved to NEW.org_id by the loop and is correctly left alone; a
  -- ticket that stayed in the source org (the common case: vulnerability
  -- remediation tickets are created org-scoped only, never device-bound) is
  -- correctly detached. Plain FK (`ticket_id` -> `tickets.id` ON DELETE SET
  -- NULL, not composite), so this can never 23503.
  UPDATE public.device_vulnerabilities dv
    SET ticket_id = NULL
    FROM public.tickets t
    WHERE dv.device_id = NEW.id
      AND dv.ticket_id = t.id
      AND t.org_id IS DISTINCT FROM NEW.org_id;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;
