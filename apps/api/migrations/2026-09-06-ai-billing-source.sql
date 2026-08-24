ALTER TABLE ai_cost_usage
  ADD COLUMN IF NOT EXISTS billing_source text NOT NULL DEFAULT 'platform';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ai_cost_usage_billing_source_chk'
      AND conrelid = 'ai_cost_usage'::regclass
  ) THEN
    ALTER TABLE ai_cost_usage
      ADD CONSTRAINT ai_cost_usage_billing_source_chk
      CHECK (billing_source IN ('platform', 'partner_key'));
  END IF;
END $$;

ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS billing_source text NOT NULL DEFAULT 'platform';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ai_sessions_billing_source_chk'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_billing_source_chk
      CHECK (billing_source IN ('platform', 'partner_key'));
  END IF;
END $$;
