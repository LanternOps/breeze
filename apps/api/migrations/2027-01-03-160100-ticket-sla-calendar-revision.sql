-- @no-transaction
-- #8973 W4 (#9784, spec §4.3): tickets.sla_calendar_revision_id — the
-- business-calendar revision a ticket's SLA deadlines are computed on,
-- snapshotted at create (NULL = 24×7, today's wall-clock rule).
--
-- In its own file, apart from 2027-01-03-160000-business-calendars.sql,
-- because tickets is a hot table: same lock discipline as
-- 2026-12-20-200300-ticket-approval-hot-table-columns.sql. Outside a
-- transaction the column is added catalog-only (nullable, no default), the FK
-- is added NOT VALID (no scan) and VALIDATEd as its own statement under
-- SHARE UPDATE EXCLUSIVE, so writes continue during the scan; every value is
-- NULL, so validation passes trivially. lock_timeout bounds how long a
-- statement may queue behind a long-running transaction; on timeout
-- autoMigrate aborts boot and the file re-runs cleanly. It is RESET before
-- the CONCURRENTLY builds, which wait for older transactions without blocking
-- writers and must not be cut short.
--
-- ON DELETE SET NULL: the calendar service refuses deleting a calendar whose
-- revisions any ticket references (spec §4.1), so the FK only fires during
-- tenant erasure, where nulling the snapshot of a row about to be deleted is
-- harmless.
--
-- Also here (W3 hand-off): tickets_sla_deadlines_missing_idx is rebuilt with
-- `sla_calendar_revision_id IS NULL` ANDed onto its whole predicate. On a
-- calendar, sla_paused_business_minutes legitimately differs from
-- sla_paused_minutes, and the calendar-aware writers own those deadlines, so
-- the Gate B12 wall-clock heal must never touch a calendar ticket. 190300 has
-- shipped and is immutable, hence the rebuild under the same name. The
-- predicate must stay identical to healMissingDeadlines() in
-- jobs/ticketSlaWorker.ts and to the Drizzle declaration in db/schema/portal.ts.
-- Between the DROP and the CREATE the heal pass scans tickets once per tick;
-- the window is the length of one CONCURRENTLY build.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, a guarded ADD CONSTRAINT, re-VALIDATE
-- is a no-op, CREATE INDEX … IF NOT EXISTS, and the heal index is dropped and
-- rebuilt to the same definition. A failed CONCURRENTLY build leaves an
-- INVALID index that IF NOT EXISTS would skip, so the final DO block raises
-- rather than letting the file be recorded.
--
-- No row is written, so no system-scope election is needed.

SET lock_timeout = '5s';

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS sla_calendar_revision_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_sla_calendar_revision_id_fk'
       AND conrelid = 'public.tickets'::regclass
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_sla_calendar_revision_id_fk
      FOREIGN KEY (sla_calendar_revision_id)
      REFERENCES public.business_calendar_revisions (id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_sla_calendar_revision_id_fk;

RESET lock_timeout;

-- The recompute job, apply-revision, the delete-in-use check and the FK's own
-- SET NULL all find tickets by revision. Partial: most tickets have none.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_calendar_revision_idx
  ON public.tickets (sla_calendar_revision_id)
  WHERE sla_calendar_revision_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS public.tickets_sla_deadlines_missing_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_deadlines_missing_idx
  ON public.tickets (created_at)
  WHERE sla_calendar_revision_id IS NULL
    AND ((response_sla_minutes IS NOT NULL AND response_due_at IS NULL)
      OR (resolution_sla_minutes IS NOT NULL AND resolution_due_at IS NULL)
      OR sla_paused_business_minutes < COALESCE(sla_paused_minutes, 0));

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.tickets'::regclass
     AND c.relname IN ('tickets_sla_calendar_revision_idx', 'tickets_sla_deadlines_missing_idx')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tickets SLA calendar index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
