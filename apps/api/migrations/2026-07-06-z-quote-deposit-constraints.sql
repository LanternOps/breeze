-- Defense-in-depth CHECK constraints for the deposit columns added in
-- 2026-07-06-quote-deposits.sql. The 0<percent<100 range and the
-- non-percent-type-carries-no-percent invariant are enforced in the app layer
-- (validateQuoteDeposit + updateQuoteSchema.refine), but any future write path
-- that bypasses updateQuote (a new route, a backfill, an AI tool, direct SQL)
-- could otherwise persist an out-of-range percent or a percent on a non-percent
-- deposit. Enforce it at the lowest layer too.
--
-- Deliberately NOT a strict `(deposit_type='percent') = (deposit_percent IS NOT
-- NULL)` biconditional: a draft may legitimately hold deposit_type='percent'
-- before the user has entered the percentage (recompute stores NULL; the
-- send-time gate blocks the quote from going out). We only forbid the always-false
-- combination — a NON-percent type carrying a percent value.

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_deposit_percent_range_chk
    CHECK (deposit_percent IS NULL OR (deposit_percent > 0 AND deposit_percent < 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_deposit_percent_type_chk
    CHECK (deposit_type = 'percent' OR deposit_percent IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_deposit_amount_nonneg_chk
    CHECK (deposit_amount IS NULL OR deposit_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_deposit_due_nonneg_chk
    CHECK (deposit_due IS NULL OR deposit_due >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
