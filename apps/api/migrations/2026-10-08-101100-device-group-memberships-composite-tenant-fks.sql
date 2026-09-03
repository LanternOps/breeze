-- #3182 -- device_group_memberships is tenant-scoped by its own org_id column
-- ALONE. The RLS policies ask "does the caller have access to this row's
-- org_id?" and never "does this row's group_id (or device_id) belong to that
-- org?", so both of these shapes are structurally legal today:
--
--   { group_id: <org A's group>, device_id: <org B's device>, org_id: B }
--   { group_id: <org A's group>, device_id: <org B's device>, org_id: A }
--
-- The issue filed this as defense-in-depth, on the reading that producing such
-- a row needs direct breeze_app credentials. It does not: the FIRST shape is
-- produced by the supported device organization-move path. Moving device D
-- from org A to org B re-stamps every device-child table's org_id to the
-- target org -- via this file's breeze_cascade_device_org_id() (whose generic
-- loop runs over breeze_device_child_orgid_tables(), a function that
-- DISCOVERS every public table carrying both a uuid device_id and org_id;
-- device_group_memberships qualifies) and via the mirrored loop in
-- routes/devices/moveOrg.ts. D's membership rows keep naming org A's group
-- while claiming org B.
--
-- Two system-side readers then dereference those rows by group_id:
--   * jobs/backupSlaWorker.ts resolveTargetDeviceIds() -- no org predicate at
--     all, under withSystemDbAccessContext (RLS bypassed), so an org A backup
--     SLA config targeting org A's group resolves org B's device D and writes
--     breach events for it stamped with org A's org_id.
--   * jobs/automationWorker.ts and the identical resolver in
--     jobs/patchSchedulerWorker.ts -- the partner-owned-policy branch clamps
--     through the MEMBERSHIP's org, never the group's, so within one partner D
--     is resolved for a policy assigned to org A's group.
-- All three readers are given explicit org predicates in the same PR; this
-- file is the structural half, which closes the shape for every future writer
-- too.
--
-- Both composite-FK targets already exist and are reused, not created:
--   device_groups_id_org_id_uniq  (2026-10-06-100100, added for contract_lines)
--   devices_id_org_id_uniq        (2026-07-23-partner-export-material-state-hardening)

-- device_group_memberships is ENABLE + FORCE ROW LEVEL SECURITY
-- (2026-04-11-bucket-c-phase-4-session-execution-rls.sql) and autoMigrate sets
-- no scope, so without the system scope the pre-flight below would count and
-- delete 0 rows on managed Postgres (non-superuser admin) and the FKs would
-- then abort boot on the rows it never saw. is_local = true scopes it to this
-- file's transaction. Same reasoning as 2026-10-06-100100.
SELECT set_config('breeze.scope', 'system', true);

-- Pre-flight repair. Unlike 2026-10-06-100100 (which RAISEs on a contract_lines
-- org mismatch), violating rows here are the EXPECTED product of a supported
-- workflow -- every past cross-org device move left some -- so raising would
-- brick the upgrade on every real database. They are deleted instead: a
-- membership naming a foreign org's group has no legitimate repair, since a
-- device in org B cannot be a member of org A's group and there is no
-- destination group to re-point it to.
--
-- The counts are reported UNCONDITIONALLY, including zero. These rows are
-- potential evidence of a tenant-isolation problem, so "we looked and found
-- none" has to be in the Postgres log too -- a silent no-op is
-- indistinguishable from a migration that never ran (CLAUDE.md's
-- cleanup-statement rule). Group and device mismatches are counted separately
-- for attribution but deleted as one union, and the deleted total is the real
-- ROW_COUNT so a row violating BOTH axes is not double-counted.
DO $preflight$
DECLARE
  group_mismatch int;
  device_mismatch int;
  deleted int;
BEGIN
  SELECT count(*) INTO group_mismatch
    FROM public.device_group_memberships m
    JOIN public.device_groups g ON g.id = m.group_id
   WHERE g.org_id <> m.org_id;
  SELECT count(*) INTO device_mismatch
    FROM public.device_group_memberships m
    JOIN public.devices d ON d.id = m.device_id
   WHERE d.org_id <> m.org_id;

  DELETE FROM public.device_group_memberships m
   WHERE EXISTS (
           SELECT 1 FROM public.device_groups g
            WHERE g.id = m.group_id AND g.org_id <> m.org_id
         )
      OR EXISTS (
           SELECT 1 FROM public.devices d
            WHERE d.id = m.device_id AND d.org_id <> m.org_id
         );
  GET DIAGNOSTICS deleted = ROW_COUNT;

  RAISE WARNING '#3182 device_group_memberships pre-flight: % row(s) named a group in another org, % row(s) named a device in another org, % row(s) deleted',
    group_mismatch, device_mismatch, deleted;
END $preflight$;

-- No ON DELETE / ON UPDATE clause on either FK -- i.e. NO ACTION, exactly the
-- semantics of the two single-column FKs these sit beside. Every deletion path
-- already removes memberships explicitly and in order (deviceDeletion.ts and
-- CORE_DEVICE_CASCADE_DELETE_TABLES for the device axis, deviceGroupDelete.ts
-- for the group axis, tenantCascade.ts for org erasure), so a referential
-- action here would change no outcome while silently taking those deletions
-- out of the cascade lists' hands.
--
-- GROUP axis: DEFERRABLE INITIALLY IMMEDIATE, like the sibling composite
-- tenant FKs (action_intents_scope_ticket_org_fk,
-- contract_lines_device_group_org_fk). DEFERRABLE at all is mandatory --
-- orgLifecycleFoundations.integration.test.ts rejects any non-deferrable FK
-- referencing a parent org_id, because the org merge runs SET CONSTRAINTS ALL
-- DEFERRED and repoints devices, device_groups and device_group_memberships in
-- separate statements. IMMEDIATE is safe here because nothing this FK
-- references (device_groups) is written by a devices org-move: the detach
-- added to breeze_cascade_device_org_id() below removes the rows before the
-- generic loop can re-stamp them, so the constraint never observes a mismatch.
ALTER TABLE public.device_group_memberships
  DROP CONSTRAINT IF EXISTS device_group_memberships_group_org_fk;
ALTER TABLE public.device_group_memberships
  ADD CONSTRAINT device_group_memberships_group_org_fk
  FOREIGN KEY (group_id, org_id) REFERENCES public.device_groups (id, org_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- DEVICE axis: INITIALLY DEFERRED, and this one is NOT stylistic. This FK
-- references devices(id, org_id), so `UPDATE devices SET org_id` fires its RI
-- check as an AFTER-row constraint trigger on devices -- the same queue, at
-- the same moment, as breeze_cascade_device_org_id() itself, whose detach is
-- what makes the check pass. Same-timing AFTER-row triggers run in
-- trigger-NAME order, and the RI trigger's internal name is not something a
-- migration controls, so IMMEDIATE would leave the move's success riding on an
-- ordering coincidence. Deferring pushes the check to COMMIT, strictly after
-- every AFTER trigger has run. Both existing composite FKs to devices(id,
-- org_id) are INITIALLY DEFERRED for the same reason
-- (2026-09-28-100000-agent-health-observations.sql,
-- 2026-08-06-d-device-mtls-certificate-history.sql).
--
-- The cost is only WHEN a violation is reported, not whether: a forged insert
-- still aborts its transaction, just at commit rather than at the statement.
ALTER TABLE public.device_group_memberships
  DROP CONSTRAINT IF EXISTS device_group_memberships_device_org_fk;
ALTER TABLE public.device_group_memberships
  ADD CONSTRAINT device_group_memberships_device_org_fk
  FOREIGN KEY (device_id, org_id) REFERENCES public.devices (id, org_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Full function body copied verbatim from
-- 2026-10-08-101000-cascade-device-org-move-vuln-ticket-detach.sql (the newest
-- definition; no later migration replaces this function) with only the
-- device_group_memberships detach added, before the generic loop.
-- CREATE OR REPLACE is idempotent by construction -- re-applying this file
-- re-installs the same body. The trigger itself (breeze_cascade_device_org_id
-- ON devices, AFTER UPDATE OF org_id ... WHEN NEW.org_id IS DISTINCT FROM
-- OLD.org_id) is unchanged and is NOT redeclared here.
--
-- A BEFORE trigger was tried first and is NOT viable, which is worth recording
-- so it is not retried: device_group_memberships carries
-- breeze_touch_devices_after_membership_delete, an AFTER DELETE STATEMENT
-- trigger that UPDATEs public.devices. Deleting memberships from a BEFORE
-- trigger on devices therefore modifies the very tuple the current command is
-- about to update, and Postgres aborts the move with SQLSTATE 27000 ("tuple to
-- be updated was already modified by an operation triggered by the current
-- command" -- whose own hint is "Consider using an AFTER trigger instead").
-- Inside this AFTER trigger the nested devices UPDATE is a separate command
-- and is fine; it does not touch org_id, so it cannot re-enter this function.
CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  child_table text;
BEGIN
  -- #3182 -- a device that has LEFT org A cannot remain a member of org A's
  -- device group, and device_group_memberships_group_org_fk ((group_id,
  -- org_id) -> device_groups(id, org_id)) now says so structurally. Delete,
  -- never re-point: device_groups.org_id is NOT NULL with no partner axis,
  -- groups nest and can be site-bound, and there is no deterministic
  -- source-group -> target-group mapping. Dynamic groups in the TARGET org
  -- re-materialize on their own next evaluation.
  --
  -- It has to precede the generic loop below, which would otherwise re-stamp
  -- these rows' org_id to NEW.org_id while their group_id still names a
  -- SOURCE-org group -- 23503 against the group FK, aborting the whole move.
  -- Same class as the action_intents tombstones, but placed FIRST rather than
  -- beside them, for a reason specific to this table: deleting a membership
  -- fires breeze_touch_devices_after_membership_delete, which acquires the
  -- partner-export EXCLUSIVE org lock for the deleted rows' org (the SOURCE
  -- org) before touching devices.partner_export_updated_at. Those locks must
  -- be taken in ascending UUID order across the whole transaction, and
  -- breeze_partner_export_devices_update -- an AFTER STATEMENT trigger on this
  -- same devices UPDATE -- goes on to request BOTH orgs. Letting the touch
  -- trigger set the high-water mark to the source org alone would then abort
  -- the move with 'partner export organization locks must be acquired in
  -- ascending UUID order' whenever the TARGET org's uuid happens to sort
  -- lower: a coin-flip per move. So take both orgs up front, in the order the
  -- helper itself sorts them into, before anything else in this function
  -- acquires one. Every later request for either org then hits the helper's
  -- already-held short-circuit and is a no-op.
  --
  -- Skipped while the SOURCE org is fenced for a merge: a merge moves the
  -- devices AND their groups to the same survivor together (orgMerge.ts /
  -- orgMergeRegistry.ts REPOINT_TABLES lists devices, device_groups and
  -- device_group_memberships) under SET CONSTRAINTS ALL DEFERRED, so the
  -- memberships stay valid and MUST survive. Same fence, and same reason, as
  -- the tickets requester_contact_id detach below.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(ARRAY[OLD.org_id, NEW.org_id]);
    DELETE FROM public.device_group_memberships WHERE device_id = NEW.id;
  END IF;
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
