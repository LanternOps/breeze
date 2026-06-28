-- Internal builder economics: per-line cost + identifier snapshots on quote_lines.
-- Internal-only — never serialized to the customer document / portal payload.
-- Nullable: a manual line may carry no cost (unknown), and legacy lines have none.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS sku varchar(100);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS part_number varchar(100);
