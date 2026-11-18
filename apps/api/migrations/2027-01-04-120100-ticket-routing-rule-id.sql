-- @no-transaction
-- #8883 W5 (#9785, spec §5.4): tickets.routing_rule_id — the routing rule that
-- matched when the ticket was created (NULL = no rule matched, import, or a
-- continuation). The applied/skipped actions are snapshotted in an internal
-- system comment, so renaming or deleting the rule loses no explanation.
--
-- In its own file, apart from 2027-01-04-120000-ticket-routing-rules.sql,
-- because tickets is a hot table: same lock discipline as
-- 2027-01-03-160100-ticket-sla-calendar-revision.sql. Outside a transaction
-- the column is added catalog-only (nullable, no default), the FK is added
-- NOT VALID (no scan) and VALIDATEd as its own statement under SHARE UPDATE
-- EXCLUSIVE, so writes continue during the scan; every value is NULL, so
-- validation passes trivially. lock_timeout bounds how long a statement may
-- queue behind a long-running transaction; on timeout autoMigrate aborts boot
-- and the file re-runs cleanly. It is RESET before the CONCURRENTLY build,
-- which waits for older transactions without blocking writers.
--
-- ON DELETE SET NULL: deleting a rule must never touch ticket history beyond
-- dropping the pointer. This edge closes no FK cycle, so it needs no
-- CASCADE_ORDER_SET_NULL_EDGE_BREAKS entry (cascadeDeleteOrg orders deletes
-- topologically from pg_constraint).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, a guarded ADD CONSTRAINT, re-VALIDATE
-- is a no-op, CREATE INDEX … IF NOT EXISTS. A failed CONCURRENTLY build leaves
-- an INVALID index that IF NOT EXISTS would skip, so the final DO block raises
-- rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed.

SET lock_timeout = '5s';

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS routing_rule_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_routing_rule_id_fk'
       AND conrelid = 'public.tickets'::regclass
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_routing_rule_id_fk
      FOREIGN KEY (routing_rule_id)
      REFERENCES public.ticket_routing_rules (id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_routing_rule_id_fk;

RESET lock_timeout;

-- The FK's own SET NULL on rule delete and the per-rule reporting read both
-- find tickets by rule. Partial: most tickets have none.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_routing_rule_idx
  ON public.tickets (routing_rule_id)
  WHERE routing_rule_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.tickets'::regclass
     AND c.relname = 'tickets_routing_rule_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tickets routing rule index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
