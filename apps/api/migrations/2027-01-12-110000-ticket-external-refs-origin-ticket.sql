-- #10120 (follow-up to #8972 ticket merge, #8313 ticket import): record the
-- ticket a merge moved a ticket_external_refs row off.
--
--   ticket_external_refs.origin_ticket_id  plain FK → tickets ON DELETE SET NULL
--
-- Set only by the moved-ref UPDATE in services/ticketMerge/repoint.ts, to the
-- tombstone the ref was written on (COALESCE: a ref moved A→B→C keeps A, as
-- ticket_comments.merged_from_ticket_id does). NULL for a ref written
-- directly; no backfill: refs moved before this column keep today's answer.
--
-- Same shape as ticket_comments.merged_from_ticket_id
-- (2027-01-04-110000-ticket-merge.sql): not composite with org_id (the row's
-- own org_id RLS already fences the referenced ticket, and a tombstone shares
-- its survivor's org), so no DEFERRABLE requirement; ON DELETE SET NULL with a
-- nullable column is safe for the org-erasure cascade on its own. No index,
-- as for merged_from_ticket_id: tickets are hard-deleted only by the org
-- cascade, which deletes these refs in the same erasure.
--
-- Export policy: included (one id). Writes no rows.

ALTER TABLE public.ticket_external_refs ADD COLUMN IF NOT EXISTS origin_ticket_id uuid;

ALTER TABLE public.ticket_external_refs
  DROP CONSTRAINT IF EXISTS ticket_external_refs_origin_ticket_id_tickets_id_fk,
  ADD CONSTRAINT ticket_external_refs_origin_ticket_id_tickets_id_fk
    FOREIGN KEY (origin_ticket_id) REFERENCES public.tickets (id) ON DELETE SET NULL;
