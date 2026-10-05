SELECT set_config('breeze.scope','system',true);
ALTER TABLE invoice_stripe_payments
  ADD COLUMN IF NOT EXISTS fee_reversed_amount numeric(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS fee_accounting_journal jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fee_accounting_error text;
DO $$
DECLARE n bigint;
BEGIN
  UPDATE invoice_stripe_payments
  SET fee_reversed_amount =
    LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
    - round(amount*LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
      /NULLIF(amount+fee_amount,0),2)
  WHERE currency='USD' AND fee_amount>0 AND fee_reversed_amount IS DISTINCT FROM
    LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
    - round(amount*LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
      /NULLIF(amount+fee_amount,0),2);
  GET DIAGNOSTICS n=ROW_COUNT;
  RAISE WARNING 'Backfilled fee reversal allocation on % Stripe mappings',n;
END $$;
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_fee_reversed_check;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_reversed_check
  CHECK (fee_reversed_amount>=0 AND fee_reversed_amount<=fee_amount);
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_fee_journal_check;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_journal_check
  CHECK (jsonb_typeof(fee_accounting_journal)='array');
ALTER TABLE invoice_stripe_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_stripe_payments FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='invoice_stripe_payments' AND policyname='breeze_org_isolation_select') THEN
    RAISE EXCEPTION 'invoice_stripe_payments org RLS precondition missing';
  END IF;
END $$;
-- Immutable predicate supports an outstanding-only partial index; settled and
-- abandoned history never enters the periodic drain.
CREATE OR REPLACE FUNCTION breeze_fee_accounting_outstanding(fee numeric,reversed numeric,journal jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE net numeric;
BEGIN
  IF fee<=0 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(journal) e WHERE e->>'state'='abandoned') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(journal) e WHERE e->>'state' IS DISTINCT FROM 'posted') THEN RETURN true; END IF;
  SELECT COALESCE(sum(CASE WHEN e->'payload'->>'direction'='refund' THEN -1 ELSE 1 END*(e->'payload'->>'amount')::numeric),0)
    INTO net FROM jsonb_array_elements(journal) e;
  RETURN net<>fee-reversed;
END $$;
CREATE INDEX IF NOT EXISTS invoice_stripe_payments_fee_outstanding_idx ON invoice_stripe_payments(id)
WHERE breeze_fee_accounting_outstanding(fee_amount,fee_reversed_amount,fee_accounting_journal);
-- Erasure is not a Stripe refund and must never depend on provider availability.
CREATE OR REPLACE FUNCTION breeze_guard_fee_journal_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('breeze.tenant_erasure',true)='1' THEN RETURN OLD; END IF;
  IF jsonb_array_length(OLD.fee_accounting_journal)=0 THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounting_connections c
    WHERE c.id::text=OLD.fee_accounting_journal->0->>'connectionId'
      AND c.status NOT IN ('disconnected','pending_tenant')) THEN RETURN OLD; END IF;
  IF breeze_fee_accounting_outstanding(OLD.fee_amount,OLD.fee_reversed_amount,OLD.fee_accounting_journal) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROCESSING_FEE_ACCOUNTING_PENDING';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS invoice_stripe_payments_fee_delete_guard ON invoice_stripe_payments;
CREATE TRIGGER invoice_stripe_payments_fee_delete_guard BEFORE DELETE ON invoice_stripe_payments
FOR EACH ROW EXECUTE FUNCTION breeze_guard_fee_journal_delete();

-- Missing accepted authority is distinct from an unusable payment method.
ALTER TABLE invoice_autopay_schedules DROP CONSTRAINT IF EXISTS invoice_autopay_schedules_ineligible_reason_check;
ALTER TABLE invoice_autopay_schedules ADD CONSTRAINT invoice_autopay_schedules_ineligible_reason_check
  CHECK (ineligible_reason IN ('not_enrolled','enrolled_after_issue','consent_required','method_not_usable','over_cap','cap_currency_mismatch','ach_currency_unsupported','excluded_contract','excluded_invoice','charging_disabled','stripe_unavailable'));
