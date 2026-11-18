-- Preserve reserved paid capacity while allowing bounded, temporary growth.
-- Existing partners receive no new allowance. Only verified billing writes it.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_admission_limit integer;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_admission_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'partners'::regclass AND conname = 'partners_billing_admission_valid') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_billing_admission_valid CHECK (
      (billing_admission_limit IS NULL AND billing_admission_expires_at IS NULL)
      OR (billing_admission_limit BETWEEN 1 AND 1100 AND billing_admission_expires_at IS NOT NULL)
    );
  END IF;
END $$;
