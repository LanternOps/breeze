-- Tax rates are stored as a FRACTION (e.g. 8.95% -> 0.0895). The original
-- numeric(6,3) scale only kept 3 fraction decimals, so any rate with more than
-- one percent decimal was truncated on save (8.95% -> 0.089 -> shows 8.9%; NYC's
-- 8.875% -> 0.089). Widen to numeric(8,5) (5 fraction decimals = 3 percent
-- decimals). Widening is lossless for existing rows. Idempotent: only ALTER when
-- the column is not already at scale 5.
DO $$
DECLARE
  tgt RECORD;
BEGIN
  FOR tgt IN
    SELECT * FROM (VALUES
      ('partners',      'default_tax_rate'),
      ('organizations', 'tax_rate'),
      ('quotes',        'tax_rate'),
      ('invoices',      'tax_rate')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = tgt.tbl AND column_name = tgt.col
        AND (numeric_precision IS DISTINCT FROM 8 OR numeric_scale IS DISTINCT FROM 5)
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE numeric(8,5)', tgt.tbl, tgt.col);
    END IF;
  END LOOP;
END $$;
