-- 2026-10-16-182100-ai-origin-attribution.sql
-- AI Scorecard W01 (#5022): record WHO DECIDED a device mutation.
--
-- ai_initiator_kind is orthogonal to script_executions.trigger_type: trigger_type
-- answers "what scheduled this run", this answers "who decided". An AI can kick
-- off a policy-driven run and a human can hand-run an AI-authored script, so
-- collapsing them would destroy information.
--
-- NULL means "AI initiation not recorded", NEVER "a human did this": every
-- AI-run library script that already exists stamps trigger_type='manual' plus
-- the invoker's user id, so all history is NULL. No backfill, no NOT NULL, no
-- DEFAULT. Consumers MUST render NULL as absence of a marker.
--
-- No DML in this file, so no set_config('breeze.scope','system',true) and no
-- entry in migrationRlsScope.test.ts's frozen baseline. (CREATE OR REPLACE
-- FUNCTION is DDL: it redefines a function body, it does not write rows.)

DO $$
BEGIN
  CREATE TYPE public.ai_initiator_kind AS ENUM ('ai_assistant', 'ai_agent');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------------------------------------------------------
-- script_executions: org-cascade tenant table. The session FK is real (both
-- tables are org-scoped and erasure should null it cleanly); the run id stays
-- a bare uuid, following script_executions.automation_run_id and
-- script_proposals.agent_run_id -- ai_agent_runs is deliberately excluded from
-- the device-move re-stamp path, so a real FK would outlive its own tenant.
-- --------------------------------------------------------------------------
ALTER TABLE public.script_executions
  ADD COLUMN IF NOT EXISTS ai_initiator_kind public.ai_initiator_kind,
  ADD COLUMN IF NOT EXISTS ai_session_id uuid,
  ADD COLUMN IF NOT EXISTS ai_agent_run_id uuid;

DO $$
BEGIN
  ALTER TABLE public.script_executions
    ADD CONSTRAINT script_executions_ai_session_id_fk
    FOREIGN KEY (ai_session_id) REFERENCES public.ai_sessions(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- --------------------------------------------------------------------------
-- device_commands: system-scoped by design (no org_id column -- the RLS and
-- cascade auto-discovery both key on the LITERAL name 'org_id', so *_id
-- columns are invisible to them and that property is untouched). Both ids are
-- bare uuids: an AI session or run that is erased, merged away or left behind
-- by a device move must not be able to block or mutate a command row. (This is
-- a RETENTION choice, not a "no tenant FKs here" rule -- submitted_org_id is a
-- real organizations FK.)
-- --------------------------------------------------------------------------
ALTER TABLE public.device_commands
  ADD COLUMN IF NOT EXISTS ai_initiator_kind public.ai_initiator_kind,
  ADD COLUMN IF NOT EXISTS ai_session_id uuid,
  ADD COLUMN IF NOT EXISTS ai_agent_run_id uuid;

-- --------------------------------------------------------------------------
-- action_intents: the origin has to survive a durable approval boundary.
-- intentReleaseWorker rebuilds the AuthContext from scratch for a human-owned
-- intent, so a chat-minted origin would be lost. Prefixed ai_origin_* to avoid
-- colliding with the existing origin_principal_kind/origin_principal_id pair,
-- which describes the REQUESTER, not the AI surface. Bare uuids: the row is
-- immutable evidence and must never be blocked by a deleted session.
-- --------------------------------------------------------------------------
ALTER TABLE public.action_intents
  ADD COLUMN IF NOT EXISTS ai_origin_kind public.ai_initiator_kind,
  ADD COLUMN IF NOT EXISTS ai_origin_session_id uuid,
  ADD COLUMN IF NOT EXISTS ai_origin_agent_run_id uuid;

-- --------------------------------------------------------------------------
-- Partial indexes for the two read paths that need them (device Scripts tab /
-- Activities feed, and the org-wide AI action count). Partial on
-- ai_initiator_kind IS NOT NULL keeps them tiny: AI rows are a small minority.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS script_executions_ai_device_created_idx
  ON public.script_executions (device_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS script_executions_ai_org_created_idx
  ON public.script_executions (org_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS device_commands_ai_device_created_idx
  ON public.device_commands (device_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;

-- --------------------------------------------------------------------------
-- Detach-on-device-move, trigger half.
--
-- Body copied VERBATIM from the newest definition,
-- 2026-10-14-100000-ai-operator-thin-slice.sql (no later migration replaces
-- this function -- verified by grepping every file in apps/api/migrations),
-- with exactly ONE statement added: the `UPDATE public.script_executions`
-- below, immediately after the ai_operator_tasks detach. CREATE OR REPLACE is
-- idempotent by construction. The trigger itself (breeze_cascade_device_org_id
-- ON devices, AFTER UPDATE OF org_id) is unchanged and is NOT redeclared here.
--
-- device_commands needs no statement here: it is not device-org-denormalized
-- and its rows are system-scoped, so nothing about them changes tenant.
-- --------------------------------------------------------------------------
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
  -- Note for a future bulk-move feature: this runs PER ROW, so it sorts one
  -- (OLD, NEW) pair at a time, whereas breeze_partner_export_devices_update
  -- sorts the whole statement's distinct org set in one pass and is therefore
  -- order-independent. Every devices.org_id writer today carries a SINGLE org
  -- pair per statement -- moveOrg.ts updates exactly one device, and the org
  -- merge's bulk repoint is always (loser -> survivor) and is skipped by the
  -- fence below anyway -- so per-row sorting is equivalent. A statement that
  -- moved devices between SEVERAL different org pairs at once could visit rows
  -- in an order that violates the ascending rule; such a feature must either
  -- keep one org pair per statement or pre-acquire the whole set here.
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
  -- AI Operator task history stays with the SOURCE org (#5205 W03, #5208):
  -- ai_operator_tasks.org_id is immutable and anchors four composite
  -- (x, org_id) FKs, so the generic re-stamp loop below deliberately excludes
  -- it. Sever the device pointer and fence any live task, mirroring
  -- moveOrg.ts's explicit statement so a DIRECT `devices.org_id` UPDATE that
  -- bypasses the route cannot strand a task pointing across tenants.
  UPDATE public.ai_operator_tasks
    SET device_id = NULL,
        target_detached_at = COALESCE(target_detached_at, now()),
        target_detached_reason = COALESCE(target_detached_reason, 'device_moved'),
        state = CASE WHEN state IN ('queued', 'running', 'waiting', 'paused') THEN 'stopping' ELSE state END,
        updated_at = now()
    WHERE device_id = NEW.id;
  -- #5022 W01: script_executions IS re-stamped to the target org (it is in
  -- CORE_DEVICE_ORG_DENORMALIZED_TABLES), but ai_agent_runs deliberately is
  -- NOT, and ai_sessions is re-stamped only when it is device-bound -- a
  -- device-less chat session stays behind. Either way a moved execution can
  -- end up pointing at a session or run in a DIFFERENT tenant. Sever both
  -- pointers and RETAIN ai_initiator_kind: the fact that an AI did the work
  -- survives the move; the cross-tenant pointer does not. Mirrored in
  -- moveOrg.ts; both copies are convergent -- the second to run matches
  -- nothing. This copy additionally covers a DIRECT devices.org_id UPDATE that
  -- bypasses the route.
  UPDATE public.script_executions
    SET ai_session_id = NULL, ai_agent_run_id = NULL
    WHERE device_id = NEW.id
      AND (ai_session_id IS NOT NULL OR ai_agent_run_id IS NOT NULL);
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
  -- #3182 safety net, same merge fence as the detach above. The generic loop
  -- just above blindly re-stamped device_group_memberships.org_id to
  -- NEW.org_id for every row naming this device -- normally none, since the
  -- detach at the top of this function already deleted them all, but the
  -- detach and this loop are two SEPARATE statements (two separate MVCC
  -- snapshots under READ COMMITTED), so a row that gets inserted for this
  -- device in the gap between them survives the detach and is instead
  -- re-stamped by the loop into exactly the forged shape the composite FKs
  -- exist to reject: org_id = NEW.org_id (target), group_id still naming a
  -- group in a DIFFERENT org. device_group_memberships_group_org_fk is
  -- DEFERRABLE INITIALLY DEFERRED (see the migration header) precisely so
  -- that mid-statement re-stamp does not abort the move outright, and this
  -- cleanup gets the chance to delete the row before COMMIT ever checks the
  -- deferred constraint. Same fence as the detach: during a merge the loop's
  -- re-stamp IS how this table's rows correctly follow the survivor (its
  -- group is repointed to the same survivor by a separate REPOINT_TABLES
  -- statement elsewhere in the merge transaction, not by this trigger), so
  -- this cleanup must stay out of that transition exactly like the detach
  -- does.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    DELETE FROM public.device_group_memberships dgm
     WHERE dgm.device_id = NEW.id
       AND EXISTS (
             SELECT 1 FROM public.device_groups g
              WHERE g.id = dgm.group_id AND g.org_id <> dgm.org_id
           );
  END IF;
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
