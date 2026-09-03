-- #4596 W2 — ticket-linked billing rows must agree with their ticket's org.
--
-- `time_entries.org_id` and `ticket_parts.org_id` are DENORMALIZED from the
-- parent ticket and were both FK'd at `organizations(id)` alone. Nothing tied
-- either to `tickets.org_id`.
--
--   * `ticket_parts` is org-axis RLS (Shape 1): four `breeze_has_org_access(org_id)`
--     policies, and the table has NO `partner_id` column at all. A cross-partner
--     `org_id` was therefore never writable there (the INSERT `WITH CHECK`
--     already confines it) — which is why the issue's proposed
--     `(org_id, partner_id)` composite is not implementable on this table.
--     Its real gap is narrower: a part could be attached to ANOTHER tenant's
--     ticket while carrying the writer's own `org_id`, and invoiceAssembly.ts
--     selects parts by `org_id`.
--   * `time_entries` is partner-axis, so the ticket/org disagreement there is
--     the mis-attribution the #4547 block-hours drawdown would inherit.
--
-- Shape copied from ticket_drafts_ticket_org_fk / action_intents_scope_ticket_org_fk
-- (2026-09-25-ai-agents-ticket-triage.sql), which already reference
-- `tickets_id_org_uq (id, org_id)` — created by that same migration, so no new
-- unique index is needed here.
--
-- DEFERRABLE INITIALLY IMMEDIATE is MANDATORY here: the REFERENCED side
-- includes a column literally named `org_id`, which
-- orgLifecycleFoundations.integration.test.ts asserts on. Org merge repoints
-- `tickets` and both children in separate statements under
-- `SET CONSTRAINTS ALL DEFERRED` (orgMerge.ts) and would abort mid-walk
-- otherwise.
--
-- The two ORG-MOVE paths need a code change alongside this file — see
-- services/ticketService.ts (moveTicketOrg) and routes/devices/moveOrg.ts. Both
-- UPDATE `tickets.org_id` BEFORE rewriting the children, so with a merely
-- IMMEDIATE check they 23503 the instant the ticket UPDATE completes. They now
-- issue `SET CONSTRAINTS` for these two constraints BY NAME (never `ALL`, which
-- would also defer tickets_requester_contact_org_fk and the ticket_drafts /
-- action_intents FKs those paths deliberately keep immediate).
--
-- The single-column ticket FKs on both tables are KEPT. Composite FKs are
-- MATCH SIMPLE, so a `time_entries` row with `ticket_id` set and `org_id NULL`
-- is not a referencing row at all and its ON DELETE SET NULL would never fire,
-- leaving a dangling ticket_id. Postgres evaluates FKs conjunctively, so the
-- surviving single-column FK is redundant, never permissive. (This is the one
-- place this migration deliberately departs from the portal_users precedent in
-- 2026-10-04-100002, which dropped its superseded FK.)
--
-- Registration (CLAUDE.md cascade table): NOTHING to add. No new table, no new
-- column, and no new PARENT table for either child — both already FK
-- `tickets(id)`, so topologicalCascadeOrder() and
-- CORE_ORG_CASCADE_DELETE_ORDER are unchanged.

SELECT set_config('breeze.scope', 'system', true);

-- Cleanup BEFORE the constraints, so a drifted row cannot abort the file.
--
-- Direction: RE-DERIVE org_id from the parent ticket, do not null it. The
-- ticket IS the authority for a ticket-linked row — that is exactly what
-- resolveTicketLink does at write time (timeEntryService.ts), and it is what
-- both org-move paths do to these very columns.
--
-- Only rows whose org_id is non-NULL and disagrees are touched. A NULL org_id
-- on a ticket-linked time entry is left alone on purpose: backfilling it would
-- violate time_entries_currency_required_when_org_chk for a row that never got
-- a currency snapshot, and such a row is attributed to no organization, so no
-- org-keyed reader counts it.
--
-- Counts reported UNCONDITIONALLY (see the W1 file for why a suppressed zero
-- is worse than a logged one).
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE time_entries te
     SET org_id = t.org_id
    FROM tickets t
   WHERE t.id = te.ticket_id
     AND te.org_id IS NOT NULL
     AND te.org_id IS DISTINCT FROM t.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 're-derived % time_entries.org_id row(s) that disagreed with their ticket', n;

  UPDATE ticket_parts tp
     SET org_id = t.org_id
    FROM tickets t
   WHERE t.id = tp.ticket_id
     AND tp.org_id IS DISTINCT FROM t.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 're-derived % ticket_parts.org_id row(s) that disagreed with their ticket', n;
END $$;

-- DROP + re-ADD rather than a bare ALTER CONSTRAINT: on a database built with
-- `drizzle-kit push` or hand-repaired, a same-named constraint could carry a
-- different definition. Re-adding is the only form that converges every shape.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_ticket_org_fk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_ticket_org_fk
  FOREIGN KEY (ticket_id, org_id)
  REFERENCES tickets (id, org_id)
  -- COLUMN-LIST form (PG15+). A bare composite SET NULL would also null
  -- `org_id` — silently destroying the org attribution of billable labour the
  -- moment its ticket is deleted. The labour still belongs to that org.
  ON DELETE SET NULL (ticket_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ticket_parts DROP CONSTRAINT IF EXISTS ticket_parts_ticket_org_fk;
ALTER TABLE ticket_parts
  ADD CONSTRAINT ticket_parts_ticket_org_fk
  FOREIGN KEY (ticket_id, org_id)
  REFERENCES tickets (id, org_id)
  -- Matches the existing single-column FK's action; a part has no meaning
  -- without its ticket.
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Referencing-side index for both constraints' lookups and for the org-move
-- rewrites, which filter on ticket_id.
CREATE INDEX IF NOT EXISTS ticket_parts_ticket_org_idx ON ticket_parts (ticket_id, org_id);
CREATE INDEX IF NOT EXISTS time_entries_ticket_org_idx
  ON time_entries (ticket_id, org_id) WHERE ticket_id IS NOT NULL;
