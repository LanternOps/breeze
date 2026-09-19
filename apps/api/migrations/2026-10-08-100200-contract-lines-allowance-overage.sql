-- #3205 wave 4 / #4607: included quantity + overage on counted contract lines.
-- Spec: docs/superpowers/specs/billing/2026-09-03-contract-line-allowance-overage-design.md
--
-- ONE file, deliberately. The wave 1 / wave 2 two-file split exists ONLY because
-- ALTER TYPE ... ADD VALUE cannot have its new value USED in the transaction that
-- adds it, and autoMigrate wraps each file in one transaction. CREATE TYPE has no
-- such restriction: 2026-10-03-partner-trust-probation.sql and
-- 2026-09-25-ticket-push-preferences.sql both create an enum and use it in the
-- same file. One file is also atomic — an enum with no consumer is dead weight
-- if a second file fails.

DO $$ BEGIN
  CREATE TYPE contract_overage_mode AS ENUM ('bill', 'flag');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS included_quantity numeric(12,2);
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS overage_mode contract_overage_mode;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS overage_unit_price numeric(12,2);

-- The DB twin of contractLineInvariantIssues (packages/shared/src/validators/
-- contracts.ts). Every conjunct is NULL-SAFE: a CHECK passes on TRUE *or NULL*,
-- so a three-valued comparison like `overage_mode <> 'bill'` would silently
-- admit rows. Each side of every `=` below is a non-null boolean, and the CASE
-- is total.
--
-- Depends on wave 2: 'per_device_group' must already exist on contract_line_type
-- (2026-10-06-100000-contract-line-type-per-device-group.sql). This file sorts
-- after it, so the value is committed and usable here.
--
-- #4547 (block hours) extends this constraint: add 'hour_block' to the type list
-- and exempt it from the integrality conjunct, by DROP + re-ADD in its own file.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_allowance_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_allowance_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat') THEN
    -- All-or-nothing: an allowance with no disposition for the extras is the
    -- silent under-bill this wave removes. Choose 'flag' to cap without billing.
    ((included_quantity IS NULL) = (overage_mode IS NULL))
    -- 0 included is a plain per-unit line at the overage rate; one spelling only.
    AND (included_quantity IS NULL OR included_quantity > 0)
    -- You cannot include 25.5 devices or 25.5 seats.
    AND (included_quantity IS NULL OR included_quantity = floor(included_quantity))
    -- A price is present iff it is actually charged. A rate parked on a 'flag'
    -- line reads as a charge on the detail page and in the tenant export.
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  ELSE
    included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  END
);
