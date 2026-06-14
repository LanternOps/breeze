-- Invoice Engine — generated PDF artifact store (Phase 5). Idempotent throughout.
-- Named with a '-c-' infix so it sorts AFTER 2026-06-15-a-invoice-engine.sql and
-- 2026-06-15-b-invoice-engine-constraints.sql (which create `invoices` and the
-- invoices_id_org_uq composite-unique index this migration's composite FK targets).
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

CREATE TABLE IF NOT EXISTS invoice_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  pdf BYTEA NOT NULL,
  sha256 CHAR(64) NOT NULL,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One artifact per invoice (generate-once).
CREATE UNIQUE INDEX IF NOT EXISTS invoice_documents_invoice_uq ON invoice_documents (invoice_id);

-- Org-consistency composite FK: the artifact's denormalized org_id must match its
-- parent invoice's org_id. Backed by invoices_id_org_uq (from -b-). ON DELETE
-- CASCADE keeps it consistent with the plain invoice_id FK above.
DO $$ BEGIN
  ALTER TABLE invoice_documents ADD CONSTRAINT invoice_documents_invoice_org_fkey
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices(id, org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS: shape 1 (direct/denormalized org_id). Four per-command policies, matching
-- the invoices / invoice_lines / invoice_payments pattern in -a-.
ALTER TABLE invoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_documents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_documents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_documents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_documents;
CREATE POLICY breeze_org_isolation_select ON invoice_documents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_documents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_documents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_documents
  FOR DELETE USING (public.breeze_has_org_access(org_id));
