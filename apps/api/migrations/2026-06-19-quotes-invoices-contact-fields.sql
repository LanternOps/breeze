-- Seller "From" contact profile on partners + Terms & Conditions block.
-- Snapshot columns on invoices/quotes mirror the existing bill_to_* snapshot model.
-- No new tables → no RLS changes (partners/invoices/quotes already have RLS).

ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_company_name varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_phone varchar(40);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_website varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_line1 varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_line2 varchar(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_city varchar(120);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_region varchar(120);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_postal_code varchar(40);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_address_country char(2);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS billing_terms_and_conditions text;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_snapshot jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS terms_and_conditions text;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS seller_snapshot jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS terms_and_conditions text;
