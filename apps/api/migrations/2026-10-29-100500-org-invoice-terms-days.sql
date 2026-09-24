-- Settings consolidation W06 (#6229, feature #6223): org-level override of the
-- partner's invoice payment terms.
--
-- NULL = inherit partners.invoice_terms_days (NOT NULL DEFAULT 30). No default
-- and no backfill: every existing org keeps inheriting. The resolved value is
-- frozen onto each invoice as due_date at issue; issued invoices are never
-- restamped. Resolver: services/invoiceTerms.ts#resolveInvoiceTermsDays.
--
-- No DML in this file, so no system-scope election is needed. Idempotent.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_terms_days integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_invoice_terms_days_range_chk'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_invoice_terms_days_range_chk
      CHECK (invoice_terms_days IS NULL OR invoice_terms_days BETWEEN 0 AND 365);
  END IF;
END $$;
