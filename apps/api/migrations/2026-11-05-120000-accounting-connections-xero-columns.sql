-- Xero W02 (spec "Settings (new columns, nullable, provider-neutral)").
--   default_exempt_tax_code_ref  Xero TaxType for non-taxable lines (QBO: ignored)
--   default_payment_account_ref  Xero bank AccountID payments apply to (QBO: ignored)
--   provider_connection_ref      Xero connection id, for targeted
--                                DELETE /connections/{id} on disconnect (QBO: null)
-- None is a secret. accounting_connections is partner-axis (RLS shape 3) and is
-- in no org cascade / export-policy registry, so no registry entry is owed.
-- Idempotent; writes no rows (so no breeze.scope election is needed).

ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS default_exempt_tax_code_ref varchar(64);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS default_payment_account_ref varchar(64);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS provider_connection_ref varchar(64);
