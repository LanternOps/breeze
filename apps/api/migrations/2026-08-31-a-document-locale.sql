-- Multi-currency wave 5 (#3777, spec §9): render-locale snapshot stamped at
-- issue (invoices) / first send (quotes) from the partner's language setting,
-- so a regenerated PDF never reflows when the partner later switches language.
-- Nullable, no default, NO backfill (owner rule: no bulk restamp of history) —
-- a NULL renders with the partner's live language at render time.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_locale varchar(16);
ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS document_locale varchar(16);
