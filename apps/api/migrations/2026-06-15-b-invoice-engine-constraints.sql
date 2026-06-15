-- Invoice Engine — DB-layer tenant-integrity constraints (defense-in-depth).
-- Backs the denormalized org_id columns added in 2026-06-15-a-invoice-engine.sql
-- with composite foreign keys so an invoice's org can never drift from its
-- partner, and a line/payment's denormalized org_id can never disagree with its
-- parent invoice. RLS already enforces tenant isolation at the policy layer; these
-- constraints make the denormalization self-consistent at the storage layer too.
-- Mirrors the users / deployment_invites dual-axis precedent. Idempotent; no
-- inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

-- Composite unique index on (id, org_id) so the child composite FKs below have a
-- referenceable target. id is already the PK, so this is trivially unique.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_id_org_uq ON invoices (id, org_id);

-- An invoice's org must belong to its partner. Backed by the existing
-- organizations(id, partner_id) unique index (organizations_id_partner_id_unique).
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_org_partner_fkey
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A line's denormalized org_id must match its parent invoice's org_id.
DO $$ BEGIN
  ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_invoice_org_fkey
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices(id, org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A payment's denormalized org_id must match its parent invoice's org_id.
DO $$ BEGIN
  ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_invoice_org_fkey
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices(id, org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
