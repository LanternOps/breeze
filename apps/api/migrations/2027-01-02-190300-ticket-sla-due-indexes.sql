-- @no-transaction
-- #8973 W3 (spec §4.3 reader 1): partial indexes for the SLA breach sweep,
-- which now range-scans the stored deadline instead of scanning created_at,
-- plus the (normally empty) index behind the sweep's Gate B12 heal pass.
-- The WHERE clauses must stay identical to the sweep predicate in
-- jobs/ticketSlaWorker.ts (and the Drizzle declarations in db/schema/portal.ts).
--
-- tickets_sla_sweep_idx (2026-06-11-g) is kept through W3 (Gate B7); a
-- follow-up drops it once these are proven in production.
--
-- Built CONCURRENTLY so the hot tickets table is never write-locked during
-- the build. IF NOT EXISTS keeps re-application a no-op. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would
-- silently accept, so the DO block fails loudly in that state (same pattern
-- as 2026-12-13-120100-tickets-partner-feed-index.sql).
-- Recovery: DROP INDEX CONCURRENTLY the index named in the error, then let
-- autoMigrate re-run this file.
--
-- No row is written, so no system-scope election is needed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_response_due_idx
  ON public.tickets (response_due_at)
  WHERE status IN ('new', 'open')
    AND work_kind = 'support'
    AND sla_paused_at IS NULL
    AND first_response_at IS NULL
    AND response_due_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_resolution_due_idx
  ON public.tickets (resolution_due_at)
  WHERE status IN ('new', 'open')
    AND work_kind = 'support'
    AND sla_paused_at IS NULL
    AND resolved_at IS NULL
    AND resolution_due_at IS NOT NULL;

-- Gate B12 rolling-deploy heal: rows that have a target but no stored
-- deadline (written by a pre-W3 API instance during the deploy). Empty once
-- the backfill above has run, so the sweep's per-tick heal is one empty index
-- probe instead of a tickets scan. Predicate must match healMissingDeadlines()
-- in jobs/ticketSlaWorker.ts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_sla_deadlines_missing_idx
  ON public.tickets (created_at)
  WHERE (response_sla_minutes IS NOT NULL AND response_due_at IS NULL)
     OR (resolution_sla_minutes IS NOT NULL AND resolution_due_at IS NULL);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.tickets'::regclass
     AND c.relname IN ('tickets_sla_response_due_idx', 'tickets_sla_resolution_due_idx', 'tickets_sla_deadlines_missing_idx')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tickets SLA due index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
