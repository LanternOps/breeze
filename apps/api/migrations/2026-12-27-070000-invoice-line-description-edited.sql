-- #8606 (feature #8601 W05, refs #8078): invoice_lines.description_edited
-- records that an operator hand-edited a line's description, so "Refresh from
-- time entries" on a draft never overwrites that edit with the source entry's
-- note. updateLine sets it only when the description actually changes; the
-- void-and-reissue clone copies it verbatim.
--
-- Column: NOT NULL with a constant DEFAULT false. On PostgreSQL 11+ (we run
-- 16) a non-volatile default is stored in the catalog, so the ADD COLUMN is a
-- metadata-only change with no table rewrite. No index: nothing filters on it.
--
-- Backfill (conservative): a draft that exists before this column cannot tell
-- an assembled description from a hand-edited one, so every time_entry line on
-- a DRAFT is marked edited. A refresh then never overwrites any description
-- that existed before the column did (it still refreshes the work date and the
-- other snapshot fields). Issued/void invoices are immutable and never
-- refreshed, so their lines keep the default. The ACCESS EXCLUSIVE lock from
-- the ADD COLUMN is held until this file's transaction commits, i.e. through
-- the backfill, which touches only draft time-entry lines.
--
-- The backfill runs ONLY when this file creates the column. Re-applying the
-- file by hand later must not flag lines on drafts assembled after the column
-- existed (those carry a real false), so the column check gates both steps.
--
-- WRITES ROWS: system scope is set first, because FORCE RLS applies to the
-- migration role. The row count is logged when rows change. Idempotent: a
-- second run finds the column and does nothing.
-- autoMigrate wraps this file in a transaction, so there is no BEGIN/COMMIT here.
DO $$
DECLARE
  n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.invoice_lines'::regclass
       AND attname = 'description_edited'
       AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE public.invoice_lines ADD COLUMN IF NOT EXISTS description_edited boolean NOT NULL DEFAULT false;

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
