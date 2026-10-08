-- @no-transaction
-- #4547 W01 (block hours): time_entries.contract_line_id — which block line, if
-- any, drew this entry. Server-written only (W02's close path stamps it together
-- with billing_status = 'contract'); no Zod schema accepts it.
-- Contract: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md (C4).
--
-- time_entries is a large, hot, partner-axis table. A plain ADD CONSTRAINT on it
-- validates inside the same statement while holding a heavy lock, and inside a
-- transaction the ACCESS EXCLUSIVE lock from adding a NOT VALID constraint would
-- still be held while a following VALIDATE scanned the table. So this file runs
-- outside a transaction and:
--   1. adds the column (catalog-only: nullable, no default, no rewrite);
--   2. adds the FK and both CHECKs NOT VALID in ONE ALTER TABLE statement
--      (catalog only, no scan; every new row is checked from this point on).
--      Dropping the old definition first makes a re-apply converge;
--   3. VALIDATEs each as its own statement, which takes only SHARE UPDATE
--      EXCLUSIVE (the FK also ROW SHARE on contract_lines), so writes continue
--      during the scan. The column is new and entirely NULL, so every
--      constraint passes trivially;
--   4. builds the partial index CONCURRENTLY, then refuses to finish if that
--      build left an INVALID index.
-- lock_timeout bounds how long steps 1-3 may queue behind a long-running
-- transaction: a statement fails after 5s instead of stalling every reader and
-- writer of time_entries; autoMigrate aborts boot and the file re-runs cleanly
-- on the next start. It is set per session (each statement is sent on its own,
-- on one connection) and RESET before step 4: CREATE INDEX CONCURRENTLY waits
-- for older transactions without blocking writers, so it must not be cut short
-- by the timeout. Precedent: 2026-12-13-110100-device-software-device-cascade.sql.
--
-- Idempotent: re-applying re-swaps and re-validates the same definitions. A
-- failed CONCURRENTLY build (cancelled, deadlocked) leaves an INVALID index that
-- IF NOT EXISTS would then skip, so the final DO block raises instead of letting
-- the file be recorded as applied; an operator must DROP INDEX CONCURRENTLY it
-- and restart (same contract as 2026-12-13-120100-tickets-partner-feed-index.sql).
--
-- No row is written, so no system-scope election is needed.

SET lock_timeout = '5s';

ALTER TABLE public.time_entries ADD COLUMN IF NOT EXISTS contract_line_id uuid;

ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_contract_line_org_fk,
  DROP CONSTRAINT IF EXISTS time_entries_contract_line_org_chk,
  DROP CONSTRAINT IF EXISTS time_entries_contract_line_chk,
  -- Composite so the line must belong to the entry's own org. MATCH SIMPLE (the
  -- default) skips a row whose org_id is NULL, which is exactly why the _org_chk
  -- below exists. ON DELETE SET NULL (contract_line_id): the PG15 column list
  -- nulls only that column; a bare SET NULL would also null org_id.
  -- DEFERRABLE INITIALLY IMMEDIATE: org merge repoints this table and
  -- contract_lines in separate statements under SET CONSTRAINTS ALL DEFERRED.
  ADD CONSTRAINT time_entries_contract_line_org_fk
    FOREIGN KEY (contract_line_id, org_id) REFERENCES public.contract_lines (id, org_id)
    ON DELETE SET NULL (contract_line_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  ADD CONSTRAINT time_entries_contract_line_org_chk
    CHECK (contract_line_id IS NULL OR org_id IS NOT NULL) NOT VALID,
  -- A line id is only ever written together with billing_status = 'contract'
  -- (spec amendment 2026-09-19: 'contract' is terminal only when a line id is set).
  ADD CONSTRAINT time_entries_contract_line_chk
    CHECK (contract_line_id IS NULL OR billing_status = 'contract') NOT VALID;

ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_contract_line_org_fk;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_contract_line_org_chk;
ALTER TABLE public.time_entries VALIDATE CONSTRAINT time_entries_contract_line_chk;

RESET lock_timeout;

-- The FK's child side (a line delete must find its entries) and the per-line
-- drawdown read. Partial: nearly every entry has no line.
CREATE INDEX CONCURRENTLY IF NOT EXISTS time_entries_contract_line_idx
  ON public.time_entries (contract_line_id) WHERE contract_line_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.time_entries'::regclass
       AND c.relname = 'time_entries_contract_line_idx'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'time_entries_contract_line_idx build left an INVALID index — DROP INDEX CONCURRENTLY it and re-apply this migration';
  END IF;
END $$;
