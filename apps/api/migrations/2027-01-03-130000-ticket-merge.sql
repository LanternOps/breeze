-- @no-transaction
-- #8972 ticket merge (spec §3.2, §8.2): the tombstone columns.
--   tickets          merged_into_ticket_id, merged_at, merged_by_user_id
--                    + tickets_merged_into_org_fk (composite, same org,
--                      DEFERRABLE INITIALLY IMMEDIATE, ON DELETE NO ACTION)
--                    + tickets_merged_into_not_self_chk
--                    + tickets_merged_pair_chk
--                    + tickets_merged_into_idx (partial)
--   ticket_comments  merged_from_ticket_id (plain FK, ON DELETE SET NULL)
--   ticket_outbox    ticket_outbox_event_type_check admits 'ticket.merged'
--
-- A merged source stays as a read-only tombstone pointing at its survivor
-- (one hop; merge compresses paths). The FK is composite on org_id so a
-- tombstone can never point outside its own org; both org movers name it in
-- their SET CONSTRAINTS … DEFERRED list because they re-stamp a survivor and
-- its tombstones in one transaction. NO ACTION keeps a survivor from being
-- hard-deleted alone; the org cascade deletes survivors and tombstones in the
-- same statement, where the check passes at statement end.
--
-- Hot-table discipline (2026-12-20-200300-ticket-approval-hot-table-columns.sql):
-- outside a transaction, each column is added catalog-only (nullable, no
-- default), each constraint is added NOT VALID (no scan) and then VALIDATEd as
-- its own statement under SHARE UPDATE EXCLUSIVE, so writes continue during the
-- scan. Every new column is entirely NULL, so validation passes trivially.
-- lock_timeout bounds how long a statement may queue behind a long-running
-- transaction; on timeout autoMigrate aborts boot and the file re-runs cleanly.
-- It is RESET before the CONCURRENTLY build, which waits for older transactions
-- without blocking writers and must not be cut short.
--
-- Idempotent: re-applying re-swaps and re-validates the same definitions. A
-- failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would
-- skip, so the final DO block raises rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed.

SET lock_timeout = '5s';

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS merged_into_ticket_id uuid;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS merged_at timestamp;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS merged_by_user_id uuid
  REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.ticket_comments ADD COLUMN IF NOT EXISTS merged_from_ticket_id uuid
  REFERENCES public.tickets(id) ON DELETE SET NULL;

-- (id, org_id) is already unique on tickets (the target of every
-- *_ticket_org_fk), so the composite reference needs no new key.
ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_merged_into_org_fk,
  ADD CONSTRAINT tickets_merged_into_org_fk
    FOREIGN KEY (merged_into_ticket_id, org_id)
    REFERENCES public.tickets (id, org_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_merged_into_org_fk;

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_merged_into_not_self_chk,
  ADD CONSTRAINT tickets_merged_into_not_self_chk
    CHECK (merged_into_ticket_id IS NULL OR merged_into_ticket_id <> id) NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_merged_into_not_self_chk;

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_merged_pair_chk,
  ADD CONSTRAINT tickets_merged_pair_chk
    CHECK ((merged_into_ticket_id IS NULL) = (merged_at IS NULL)) NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_merged_pair_chk;

-- ticket_outbox admits the new event (spec §3.7). event_type is text, but
-- 2026-09-19-ai-agents-ticket-shadow.sql pins the admitted set with a named
-- CHECK, widened here the same way (swap NOT VALID, then VALIDATE: the
-- existing rows all satisfy the wider set).
ALTER TABLE public.ticket_outbox
  DROP CONSTRAINT IF EXISTS ticket_outbox_event_type_check,
  ADD CONSTRAINT ticket_outbox_event_type_check
    CHECK (event_type IN (
      'ticket.created', 'ticket.status_changed', 'ticket.updated',
      'ticket.assigned', 'ticket.commented', 'ticket.restored',
      'ticket.merged'
    )) NOT VALID;
ALTER TABLE public.ticket_outbox VALIDATE CONSTRAINT ticket_outbox_event_type_check;

RESET lock_timeout;

-- The FK's referencing side (a survivor delete must find its tombstones), path
-- compression and the inbound/portal one-hop lookups. Partial: almost every
-- ticket is not merged.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_merged_into_idx
  ON public.tickets (merged_into_ticket_id) WHERE merged_into_ticket_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.tickets'::regclass
     AND c.relname = 'tickets_merged_into_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tickets merge index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
