-- #9664: a `manual` contract line must carry a quantity.
--
-- resolveLineQty and generateDueInvoice used to read a NULL manual_quantity as
-- 0, so a manual line with no quantity put a silent $0 line on the customer's
-- invoice. The shared validator already requires the quantity, and every app
-- writer stores one (add/spec writers default to '0' only for an absent field
-- the validator has already rejected, and quote conversion copies the quote
-- line's NOT NULL quantity), but nothing stopped a direct write, import or
-- seed. This CHECK closes that, and the services now refuse such a line
-- (MANUAL_QUANTITY_MISSING) instead of billing it as 0.
--
-- NOT VALID first, then VALIDATE: an install that already holds an offending
-- row (only possible through a direct write) must not fail autoMigrate. On
-- such an install the CHECK stays NOT VALID (still enforced on every INSERT and
-- UPDATE), the RAISE WARNING records how many rows, and contract generation
-- refuses those contracts until an operator sets the quantity. A clean install
-- ends VALIDATED. No row is rewritten: there is no correct quantity to invent.
--
-- Idempotent: the ADD is guarded by a pg_constraint lookup, and VALIDATE on an
-- already-valid constraint is a no-op.
--
-- System scope: contract_lines is FORCE ROW LEVEL SECURITY, so the diagnostic
-- count below would otherwise see zero rows. This file writes no rows.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'contract_lines_manual_quantity_chk'
       AND conrelid = 'public.contract_lines'::regclass
  ) THEN
    ALTER TABLE public.contract_lines
      ADD CONSTRAINT contract_lines_manual_quantity_chk
      CHECK (line_type <> 'manual' OR manual_quantity IS NOT NULL) NOT VALID;
  END IF;

  BEGIN
    ALTER TABLE public.contract_lines VALIDATE CONSTRAINT contract_lines_manual_quantity_chk;
  EXCEPTION WHEN check_violation THEN
    SELECT count(*) INTO n FROM public.contract_lines
     WHERE line_type = 'manual' AND manual_quantity IS NULL;
    RAISE WARNING 'contract_lines_manual_quantity_chk left NOT VALID: % manual contract line(s) have no manual_quantity; contract generation refuses them (MANUAL_QUANTITY_MISSING) until a quantity is set', n;
  END;
END $$;
