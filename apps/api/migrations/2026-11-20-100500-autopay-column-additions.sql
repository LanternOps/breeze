SELECT set_config('breeze.scope','system',true);
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'ach_debit';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS autopay_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS autopay_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE invoice_stripe_payments
 ADD COLUMN IF NOT EXISTS fee_amount numeric(12,2) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS payment_method_type text,
 ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'checkout';
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_fee_amount_chk;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_amount_chk CHECK (fee_amount >= 0);
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_method_type_chk;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_method_type_chk CHECK (payment_method_type IN ('card','us_bank_account'));
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_source_chk;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_source_chk CHECK (source IN ('checkout','autopay'));
ALTER TABLE stripe_connect_accounts
 ADD COLUMN IF NOT EXISTS autopay_capabilities_checked_at timestamptz,
 ADD COLUMN IF NOT EXISTS autopay_missing_permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS autopay_enabled boolean NOT NULL DEFAULT false;
