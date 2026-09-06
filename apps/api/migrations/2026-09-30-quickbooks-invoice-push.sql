-- Phase C (invoice push) — Task 2: realm multi-currency flag + customer
-- currency + QBO-assigned DocNumber on collision. No RLS changes: both
-- tables already ENABLE+FORCE with partner policies; no new table.

ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS multi_currency_enabled boolean;
ALTER TABLE accounting_entity_mappings ADD COLUMN IF NOT EXISTS remote_currency_code char(3);
ALTER TABLE accounting_entity_mappings ADD COLUMN IF NOT EXISTS remote_doc_number varchar(40);
