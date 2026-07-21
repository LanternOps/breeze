-- Quote deposits (spec: docs/superpowers/specs/billing/2026-07-05-quote-deposits-design.md).
-- Columns only — no new tables, RLS untouched.

DO $$ BEGIN
  CREATE TYPE quote_deposit_type AS ENUM ('none', 'percent', 'selected_lines');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_type quote_deposit_type NOT NULL DEFAULT 'none';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_percent numeric(5,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_amount numeric(12,2);

ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS deposit_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS item_type catalog_item_type;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deposit_due numeric(12,2);
