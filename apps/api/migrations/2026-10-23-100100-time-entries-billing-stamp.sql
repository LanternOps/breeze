-- W02 billing snapshots. Nullable columns / constant boolean default avoid a
-- table rewrite. billable_minutes and its arithmetic CHECK belong to W03.
-- DDL only; autoMigrate owns the transaction. Safe to replay.
ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS billing_profile_id uuid,
  ADD COLUMN IF NOT EXISTS coverage text,
  ADD COLUMN IF NOT EXISTS billing_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS minimum_minutes integer,
  ADD COLUMN IF NOT EXISTS rounding_increment_minutes integer;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS labour_pricing_converted_at timestamptz;

-- NO ACTION preserves billing history. Partner erasure orders referrers first
-- using FK edges. This references partner_id, not the org-merge axis.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'time_entries'::regclass AND conname = 'time_entries_billing_profile_partner_fk') THEN
    ALTER TABLE time_entries ADD CONSTRAINT time_entries_billing_profile_partner_fk
      FOREIGN KEY (billing_profile_id, partner_id)
      REFERENCES billing_profiles (id, partner_id) ON DELETE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'time_entries'::regclass AND conname = 'time_entries_coverage_chk') THEN
    ALTER TABLE time_entries ADD CONSTRAINT time_entries_coverage_chk
      CHECK (coverage IN ('billable', 'included', 'non_billable')) NOT VALID;
  END IF;
END $$;
ALTER TABLE time_entries VALIDATE CONSTRAINT time_entries_coverage_chk;
