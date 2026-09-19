-- #4454 — mirror moveOrg's action_intents scope tombstone into
-- breeze_cascade_device_org_id().
--
-- `apps/api/src/routes/devices/moveOrg.ts` tombstones the typed target scope of
-- every LIVE intent aimed at a device that is leaving its org:
--
--     UPDATE action_intents SET scope_device_id = NULL
--       WHERE scope_device_id = <deviceId>
--         AND status IN ('pending_approval','approved','executing')
--
-- The DB-side cascade — breeze_cascade_device_org_id(), the path taken by
-- direct-SQL / non-route callers such as orgMerge's `devices` repoint — never
-- mirrored it. P2-2 review round 1 scoped that fix to the route only and
-- recorded the hole as a known gap in moveOrg.coverage.test.ts. A raw
-- `UPDATE devices SET org_id = ...` therefore left a LIVE intent still naming a
-- device that now belongs to a different tenant: exactly the cross-tenant
-- dangling-pointer class #3828 closed for metric_anomaly_incidents.agent_run_id
-- and #4215 closed for ai_agent_runs.ticket_id, both of which were carried the
-- same way until they were mirrored into this function.
--
-- Placement: immediately after the metric_anomaly_incidents reverse pointer and
-- BEFORE the tickets requester detach and the generic
-- breeze_device_child_orgid_tables() re-stamp loop — the same internal order
-- the route uses. `action_intents` is NOT returned by that function (its device
-- pointer is `scope_device_id`, not `device_id`, deliberately so —
-- cascadeDelete.test.ts keys on `device_id`), so the loop can never reach these
-- rows; and action_intents.org_id is immutable
-- (action_intents_block_content_update()), so the intent can never follow the
-- device. Tombstoning the pointer is the only available correct outcome.
--
-- LIVE STATUSES ONLY, matching the route and the schema comment on
-- actionIntents.scopeDeviceId: a terminal-status intent is a historical record
-- of an action already decided, and its target device at decision time is a
-- fact, not something a future release path re-validates. Only a LIVE intent
-- can still reach release (services/actionIntents/intentTargetScope.ts), which
-- fails closed on a NULL scope_device_id.
--
-- PERMITTED BY THE IMMUTABILITY TRIGGER. action_intents_block_content_update()
-- (newest definition: 2026-09-25-ai-agents-ticket-triage.sql) rejects a
-- scope_device_id change only when `NEW.scope_device_id IS NOT NULL`, so
-- non-null -> NULL is the one transition it allows — the same transition the
-- FK's ON DELETE SET NULL makes on a device delete. This UPDATE is the
-- tombstone path, not a bypass. `action_intents_scope_device_chk`
-- (`scope_device_id IS NULL OR scope_kind = 'device'`) is likewise satisfied:
-- scope_kind is left alone and a kind without an id IS the tombstone.
--
-- NO MERGE FENCE, deliberately — unlike the tickets requester detach directly
-- below it, which skips itself while `organizations.status = 'merging'` because
-- the contact travels to the survivor org alongside the ticket. An intent never
-- travels: services/orgMergeRegistry.ts classifies `action_intents` as
-- `leave-for-erasure` precisely because org_id is trigger-immutable, so a
-- repoint would raise and abort the merge. A live intent in a merging loser org
-- is therefore erased with the loser shell no matter what this trigger does,
-- and both outcomes fail closed at release (tombstone, or the org-mismatch
-- check). Tombstoning is the strictly safer of the two: it leaves no
-- cross-tenant device id behind at all.
--
-- THE STATEMENT RUNS UNDER THE CALLER'S ACCESS CONTEXT, not the definer's.
-- SECURITY DEFINER switches the ROLE; it does not touch the `breeze.*` GUCs
-- that breeze_current_scope() reads, and action_intents is FORCE ROW LEVEL
-- SECURITY. Both callers that exist today set a context that satisfies
-- breeze_has_org_access(org_id): the moveOrg route's request context spans
-- source and target orgs (the devices UPDATE that fired this trigger already
-- proved that), and orgMerge Phase B wraps its whole transaction in
-- withSystemDbAccessContext, where the helper short-circuits TRUE. A future
-- contextless caller -- an ad hoc psql fix, or a script that forgets the
-- wrapper -- would land on scope='none' and this UPDATE would match zero rows
-- silently.
--
-- Deliberately NOT instrumented with GET DIAGNOSTICS + RAISE WARNING, unlike a
-- migration cleanup statement. Zero rows is the OVERWHELMINGLY common normal
-- case here: the trigger fires on every device org-move and most moved devices
-- have no intent scoped to them at all, so a warning would fire constantly and
-- train readers to ignore it. Worse, the "did we miss rows?" probe would have
-- to read action_intents under the SAME context that just hid them, so it
-- cannot detect the one case it exists for. The real backstop is at release:
-- services/actionIntents/agentReleaseAuthority.ts refuses a device whose
-- CURRENT org_id no longer matches the intent's, so a tombstone that never
-- fired still fails closed. This statement is defense in depth and data
-- hygiene, not the security boundary.
--
-- NO HISTORICAL BACKFILL, for the reason 2026-09-29's header gives for the same
-- omission: action_intents is FORCE ROW LEVEL SECURITY, so a bare cleanup
-- statement here — run without a `breeze.scope` access context — is subject to
-- policy even for the table owner and would match zero rows on a managed
-- Postgres, reporting a silent "0 cleaned" while leaving the rows in place.
-- Pre-fix rows are already failed closed by the release path's org-mismatch
-- check (intentTargetScope.ts), so they are not exploitable; a sweep, if ever
-- wanted, belongs in a scripted backfill under a known access context.
--
-- Full function body copied from 2026-10-04-100000-ticket-requester-contact.sql
-- (the newest definition; no later migration replaces this function) with only
-- the action_intents statement added. CREATE OR REPLACE is idempotent by
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
