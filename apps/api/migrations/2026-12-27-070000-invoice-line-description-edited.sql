-- #8606 (feature #8601 W05, refs #8078): invoice_lines.description_edited
-- records that an operator hand-edited a line's description, so "Refresh from
-- time entries" on a draft never overwrites that edit with the source entry's
-- note. updateLine sets it only when the description actually changes; the
-- void-and-reissue clone copies it verbatim.
--
-- Column: NOT NULL with a constant DEFAULT false. On PostgreSQL 11+ (we run
-- 16) a non-volatile default is stored in the catalog, so the ADD COLUMN is a
-- metadata-only change: no table rewrite and only a brief ACCESS EXCLUSIVE
-- lock on this hot table. No index: nothing filters on it.
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS description_edited boolean NOT NULL DEFAULT false;

-- Backfill (conservative): an existing draft cannot tell an assembled
-- description from a hand-edited one, so every time_entry line on a DRAFT is
-- marked edited. A refresh then never overwrites any description that existed
-- before this column did (it still refreshes the work date and the other
-- snapshot fields). Issued/void invoices are immutable and never refreshed, so
-- their lines keep the default.
--
-- WRITES ROWS: system scope is set first, because FORCE RLS applies to the
-- migration role. The row count is logged when rows change. Idempotent: the
-- `description_edited = false` predicate makes a second run match nothing.
-- autoMigrate wraps this file in a transaction, so there is no BEGIN/COMMIT here.
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.invoice_lines il
     SET description_edited = true
    FROM public.invoices i
   WHERE i.id = il.invoice_id
     AND i.status = 'draft'
     AND il.source_type = 'time_entry'
     AND il.description_edited = false;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'invoice_lines.description_edited backfill: flagged % row(s) on draft invoices', n;
  END IF;
END $$;
