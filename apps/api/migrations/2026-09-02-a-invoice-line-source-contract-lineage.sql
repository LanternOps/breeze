-- Multi-currency wave 6 (#3778), Task 14 — DURABLE CONTRACT LINEAGE ON INVOICE LINES.
--
-- WHY. The owner-approved ACTIVE-contract currency restamp may only run when the
-- contract owns no unbilled monetary rows. Today contract ownership of an invoice
-- line is NOT durable: invoice_lines.source_id is nullable and polymorphic
-- (FK-by-convention only), addContractLine accepts a null sourceId, and
-- removeContractLine is permitted on ACTIVE contracts. So this escape exists —
--
--   active USD contract line -> unissued draft invoice line
--     -> contract line removed -> the draft line's source is no longer in
--        contract_lines -> the contract looks eligible and restamps,
--        stranding USD money on a live draft.
--
-- A durable, same-tenant-FK'd source_contract_id closes it: the column survives
-- contract_lines deletion and is only cleared when the CONTRACT itself is deleted.
--
-- Idempotent; re-application is a no-op. No inner BEGIN/COMMIT (autoMigrate wraps
-- each file in a transaction).

-- Composite-FK target. contracts.id is already the PK so this is trivially unique;
-- it exists so the (source_contract_id, org_id) FK below can enforce same-tenant
-- linkage in the DB, mirroring invoices_id_org_uq.
CREATE UNIQUE INDEX IF NOT EXISTS contracts_id_org_uq ON contracts (id, org_id);

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS source_contract_id uuid;

-- Same-tenant linkage enforced by the DB. ON DELETE SET NULL names the column
-- explicitly (PG 15+) so deleting a contract clears ONLY the lineage pointer —
-- org_id is NOT NULL and must never be nulled. MATCH SIMPLE (the default) means
-- the constraint is not checked while source_contract_id IS NULL, which is the
-- correct behaviour for the many non-contract lines.
DO $$ BEGIN
  ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_source_contract_org_fkey
    FOREIGN KEY (source_contract_id, org_id)
    REFERENCES contracts(id, org_id) ON DELETE SET NULL (source_contract_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS invoice_lines_source_contract_idx
  ON invoice_lines (source_contract_id) WHERE source_contract_id IS NOT NULL;

-- Backfill from the CURRENT contract-source convention (source_type='contract'
-- with source_id -> contract_lines.id). Rows whose contract line has already been
-- deleted cannot be attributed and are deliberately left NULL: the service treats
-- them as ORPHANED_CONTRACT_SOURCE and refuses to restamp rather than guessing.
-- The row count is RAISEd (never silent) so the forensic trail survives.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE invoice_lines il
     SET source_contract_id = cl.contract_id
    FROM contract_lines cl
   WHERE il.source_type = 'contract'
     AND il.source_contract_id IS NULL
     AND il.source_id = cl.id
     AND cl.org_id = il.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % invoice_line contract lineage rows', n;
  END IF;
END $$;

-- Report (never silently fix) the contract-source lines that could NOT be
-- attributed — these are exactly the rows that will block an ACTIVE restamp.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM invoice_lines
   WHERE source_type = 'contract' AND source_contract_id IS NULL;
  IF n > 0 THEN
    RAISE WARNING 'left % unattributable contract-source invoice_line row(s) (ORPHANED_CONTRACT_SOURCE)', n;
  END IF;
END $$;
