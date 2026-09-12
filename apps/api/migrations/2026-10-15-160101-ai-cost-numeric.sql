-- Keep AI session and aggregate cost accounting exact at the same six-decimal
-- cent precision as durable budget reservations. REAL/float4 loses fractional
-- cents immediately and eventually loses whole cents at high valid totals.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_sessions'
      AND column_name = 'total_cost_cents'
      AND (
        data_type <> 'numeric'
        OR numeric_precision IS DISTINCT FROM 20
        OR numeric_scale IS DISTINCT FROM 6
      )
  ) THEN
    ALTER TABLE ai_sessions
      ALTER COLUMN total_cost_cents TYPE numeric(20,6)
      USING total_cost_cents::numeric(20,6);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_cost_usage'
      AND column_name = 'total_cost_cents'
      AND (
        data_type <> 'numeric'
        OR numeric_precision IS DISTINCT FROM 20
        OR numeric_scale IS DISTINCT FROM 6
      )
  ) THEN
    ALTER TABLE ai_cost_usage
      ALTER COLUMN total_cost_cents TYPE numeric(20,6)
      USING total_cost_cents::numeric(20,6);
  END IF;
END $$;
