-- Wave 2 (#3774): all document constructors now stamp currency explicitly
-- (from the org, or copied from the source document). Remove the USD
-- backstop so a missed stamp is a loud 23502, not a silent USD document.
ALTER TABLE invoices  ALTER COLUMN currency_code DROP DEFAULT;
ALTER TABLE quotes    ALTER COLUMN currency_code DROP DEFAULT;
ALTER TABLE contracts ALTER COLUMN currency_code DROP DEFAULT;
