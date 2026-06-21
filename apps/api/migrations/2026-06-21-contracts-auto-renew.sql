-- Contracts auto-renew + renewal notices. Idempotent throughout.
-- Sorts after 2026-06-15-d-recurring-contracts.sql (contracts table already exists).

-- 1. New columns on contracts.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS renewal_term_months INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS renewal_notice_days INTEGER;
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_renewal_term_months_positive
    CHECK (renewal_term_months IS NULL OR renewal_term_months > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_renewal_notice_days_nonneg
    CHECK (renewal_notice_days IS NULL OR renewal_notice_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Notice-kind enum + idempotency-ledger table.
DO $$ BEGIN
  CREATE TYPE contract_renewal_notice_kind AS ENUM ('advance','renewed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS contract_renewal_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  end_date DATE NOT NULL,
  kind contract_renewal_notice_kind NOT NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_renewal_notices_uq
  ON contract_renewal_notices (contract_id, end_date, kind);
CREATE INDEX IF NOT EXISTS contract_renewal_notices_org_idx
  ON contract_renewal_notices (org_id);

-- 3. RLS: shape 1 (direct org_id).
ALTER TABLE contract_renewal_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_renewal_notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_renewal_notices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_renewal_notices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_renewal_notices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_renewal_notices;
CREATE POLICY breeze_org_isolation_select ON contract_renewal_notices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_renewal_notices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_renewal_notices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_renewal_notices
  FOR DELETE USING (public.breeze_has_org_access(org_id));
