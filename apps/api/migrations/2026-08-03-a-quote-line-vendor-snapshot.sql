-- Vendor identity snapshot on quote lines (procurement breakdown spec,
-- docs/superpowers/specs/billing/2026-08-03-quote-procurement-breakdown-design.md).
-- Nullable on purpose: historical lines stay NULL (no backfill — deriving an
-- "add-time" snapshot from today's catalog would fabricate data).
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS procurement_source varchar(40);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS vendor_sku varchar(100);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS manufacturer varchar(255);
