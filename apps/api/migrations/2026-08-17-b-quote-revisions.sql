-- Quote revisions (spec 2026-08-17): lineage columns + linearity constraints.
-- No RLS changes: quotes' existing shape-1 org policies cover the new columns.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_of_quote_id uuid;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1;

-- Same-tenant lineage: composite self-FK onto quotes_id_org_uq so a revision
-- can never point at another org's quote. No ON DELETE action needed: issued
-- quotes cannot be deleted (delete is draft-only) and org erasure removes the
-- whole lineage in one statement (FKs are checked at statement end).
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_revision_of_fk
    FOREIGN KEY (revision_of_quote_id, org_id) REFERENCES quotes (id, org_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Linear lineage forever: at most ONE immediate successor per quote (drafts
-- included). Deleting an abandoned revision draft frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_revision_of_uq
  ON quotes (revision_of_quote_id) WHERE revision_of_quote_id IS NOT NULL;

-- Root <=> revision 1.
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_revision_number_chk
    CHECK ((revision_of_quote_id IS NULL AND revision_number = 1)
        OR (revision_of_quote_id IS NOT NULL AND revision_number >= 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
