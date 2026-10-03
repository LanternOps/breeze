SELECT set_config('breeze.scope','system',true);
ALTER TABLE accounting_connections
  ADD COLUMN IF NOT EXISTS fee_income_item_ref varchar(64),
  ADD COLUMN IF NOT EXISTS fee_income_account_ref varchar(64);
ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_connections FORCE ROW LEVEL SECURITY;
-- Retain the existing four partner policies. Fail rather than weaken isolation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='accounting_connections' AND policyname='breeze_partner_isolation_select') THEN
    RAISE EXCEPTION 'accounting_connections partner RLS precondition missing';
  END IF;
END $$;
