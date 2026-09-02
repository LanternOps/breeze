-- tickets.requester_contact_id: the canonical PERSON on a ticket (#3258 W03)
--
-- Inbound email used to mint a password-less `portal_users` row per unknown
-- sender purely so the ticket had *something* to attribute to. Those rows are
-- not logins, they duplicate the person that `contacts` already models, and
-- they made "who filed this?" answerable only through an auth table. From this
-- migration forward the requester is a `contacts` row and `submitted_by` means
-- exactly one thing: the OPTIONAL portal LOGIN that filed it.
--
-- Shape: the FK is COMPOSITE against `contacts_id_org_id_uniq` (id, org_id),
-- so a cross-org requester is unrepresentable rather than merely validated —
-- the same construction `contacts_site_org_fk` uses for its site pin. Two
-- non-obvious clauses:
--   * `ON DELETE SET NULL (requester_contact_id)` — the COLUMN LIST form
--     (PG 15+). A bare composite SET NULL would also null `org_id`, which is
--     NOT NULL, so deleting a contact would fail instead of unlinking.
--   * `DEFERRABLE INITIALLY IMMEDIATE` — required of every composite FK on an
--     org-cascade table by orgLifecycleFoundations.integration.test.ts; org
--     merge re-tenants rows inside one transaction and needs to defer.
--
-- Registration (CLAUDE.md cascade table): `tickets` is already in
-- CORE_ORG_CASCADE_DELETE_ORDER and CORE_TENANT_EXPORT_POLICY. The export
-- policy row is the one that fires on a NEW COLUMN, not just a new table —
-- `requester_contact_id` is classified `included` (a tenant identifier
-- pointing at the org's own contact row) in tenantExportPolicyRegistry.ts.

-- `tickets` is ENABLE + FORCE ROW LEVEL SECURITY and `breeze_current_scope()`
-- defaults to 'none' (deny), so the backfill UPDATE below would match ZERO rows
-- on managed Postgres where the migration role is not a superuser — a silent
-- no-op that reports a truthful-looking "backfilled 0". `is_local = true`
-- scopes this to autoMigrate's per-file transaction.
-- See 2026-09-30-100000-rls-scoped-backfill-replay.sql for the full write-up.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_contact_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tickets_requester_contact_org_fk'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_requester_contact_org_fk
      FOREIGN KEY (requester_contact_id, org_id)
      REFERENCES contacts (id, org_id)
      ON DELETE SET NULL (requester_contact_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Partial: the vast majority of historic tickets have no contact link, and the
-- only query shape is "tickets for THIS contact" (portal ownership by contact).
CREATE INDEX IF NOT EXISTS tickets_requester_contact_idx
  ON tickets (requester_contact_id)
  WHERE requester_contact_id IS NOT NULL;

-- Backfill: every ticket whose portal login is already linked to a contact
-- (2026-08-19-contacts.sql backfilled portal_users.contact_id exhaustively)
-- gets the canonical person it should have had. The `pu.org_id = t.org_id`
-- predicate is redundant with the FK but keeps the statement itself
-- cross-tenant-safe if it is ever replayed by hand.
--
-- The `EXISTS` on `contacts` is the load-bearing one, and it is NOT redundant
-- with `pu.org_id = t.org_id`: `portal_users.contact_id` is a SINGLE-column FK
-- to `contacts(id)`, so nothing in the schema forces a login and its contact
-- into the same org. A drifted row (a contact moved between orgs, a hand-run
-- repair) would make this statement propose a cross-org pair that
-- `tickets_requester_contact_org_fk` rejects — and a 23503 inside a migration
-- aborts the whole FILE, on every database that has the drift, with no way to
-- skip it. Filtering the pair here means such a ticket is simply left
-- unlinked (recoverable) instead of blocking the deploy.
--
-- The count is reported UNCONDITIONALLY. A zero is the interesting number:
-- the header above argues this backfill should match every login-filed
-- ticket, so `backfilled 0` on a production database with portal history is
-- evidence the premise is wrong (or that RLS silently ate the UPDATE — see
-- the `breeze.scope` note at the top of this file, which is exactly the
-- failure mode a suppressed 0 hides).
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE tickets t
     SET requester_contact_id = pu.contact_id
    FROM portal_users pu
   WHERE t.submitted_by = pu.id
     AND pu.org_id = t.org_id
     AND pu.contact_id IS NOT NULL
     AND t.requester_contact_id IS NULL
     AND EXISTS (
       SELECT 1 FROM contacts c
        WHERE c.id = pu.contact_id
          AND c.org_id = t.org_id
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % tickets.requester_contact_id from portal_users.contact_id', n;
END $$;

-- ---------------------------------------------------------------------------
-- Device org-move: detach the requester before the generic re-stamp.
-- ---------------------------------------------------------------------------
-- `tickets` is returned by breeze_device_child_orgid_tables(), so moving a
-- device to another org makes breeze_cascade_device_org_id() issue
-- `UPDATE tickets SET org_id = <target> WHERE device_id = <device>`. org_id is
-- half of the composite `tickets_requester_contact_org_fk`, which is
-- DEFERRABLE INITIALLY IMMEDIATE — checked at the END of that statement — so a
-- contact-linked ticket on the moved device raises 23503 and the device move
-- fails outright. Same failure mode, and the same fix, as the ticket-level
-- move in services/ticketService.ts (moveTicketOrg) and as the
-- ticket_drafts / action_intents detaches recorded in that function's C1
-- comment (#4191).
--
-- The detach must run BEFORE the generic loop: the loop's own statement is
-- what trips the constraint, so a cleanup placed after it never executes.
--
-- ORG MERGE MUST KEEP THE LINK. Merge repoints `devices` (REPOINT_TABLES) with
-- an org_id UPDATE, which fires this trigger — but there the CONTACT is moving
-- to the survivor org too (orgMergeRegistry classifies `contacts` custom /
-- repoint, and it never deletes), so the link stays valid and nulling it would
-- silently destroy the customer's portal ownership of their own tickets. The
-- merge is issued under `SET CONSTRAINTS ALL DEFERRED`, so its FK check waits
-- for COMMIT by which time `contacts` has moved.
--
-- The gate is the merge FENCE, not a probe of where the contact currently
-- lives: the merge walk is parents-first and repoints `devices` BEFORE
-- `contacts`, so at trigger time the contact is still under the loser org and
-- an "is the contact already in the target org?" test would answer no and
-- detach exactly the rows it is meant to protect. `organizations.status =
-- 'merging'` is set by orgMerge's fenceLoser() before the merge transaction
-- opens and is the same signal the portal org-status gate keys on, so it is
-- true for every statement the merge issues and false for every ordinary
-- device move (a fenced org refuses those). Failing the probe (an invisible
-- org row) falls through to DETACH, which is the FK-safe direction.
--
-- Full function body copied from 2026-09-29-detach-ticket-runs-on-device-org-
-- move.sql (the newest definition; no later migration replaces this function)
-- with only the tickets statement added. CREATE OR REPLACE is idempotent.
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
  -- The requester CONTACT is org-pinned and does not travel with the device
  -- (#3258 W03). Skipped while the source org is fenced for a merge, where the
  -- contact moves to the survivor alongside the ticket — see the header above.
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
