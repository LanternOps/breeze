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
-- Erasure is not a Stripe refund. Completed bookkeeping can be erased; an owed
-- operation or an unexported reversal cannot lose its durable identity.
CREATE OR REPLACE FUNCTION breeze_guard_fee_journal_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE net numeric; unfinished boolean;
BEGIN
  IF jsonb_array_length(OLD.fee_accounting_journal)=0 THEN RETURN OLD; END IF;
  SELECT COALESCE(sum(CASE WHEN e->'payload'->>'direction'='refund' THEN -1 ELSE 1 END*(e->'payload'->>'amount')::numeric),0),
    COALESCE(bool_or(e->>'state' IS DISTINCT FROM 'posted'),false)
    INTO net,unfinished FROM jsonb_array_elements(OLD.fee_accounting_journal) e;
  IF unfinished OR net<>OLD.fee_amount-OLD.fee_reversed_amount THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROCESSING_FEE_ACCOUNTING_PENDING';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS invoice_stripe_payments_fee_delete_guard ON invoice_stripe_payments;
CREATE TRIGGER invoice_stripe_payments_fee_delete_guard BEFORE DELETE ON invoice_stripe_payments
FOR EACH ROW EXECUTE FUNCTION breeze_guard_fee_journal_delete();
