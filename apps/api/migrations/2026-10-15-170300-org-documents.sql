-- org_documents — the organization document library (spec #5573 §4.4, D5/D7).
-- Shape 1 (direct org_id). DDL only: no rows written, so no breeze.scope election.
-- Bytes live in ONE of two places, chosen once at upload and never re-derived:
-- an S3 object or inline bytea. Keys carry NO tenant identifier — the row is the
-- authority, so an org merge re-stamps org_id on rows only and objects never move.
-- Versioning is a backwards linked list: the NEW document points at the one it
-- replaces. UNIQUE (supersedes_document_id) forbids branching and the service
-- refuses to replace a non-head; together those make a cycle unconstructible.

DO $$ BEGIN
  CREATE TYPE org_document_category AS ENUM
    ('baseline','runbook','policy','evidence','report','export','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS org_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  category org_document_category NOT NULL DEFAULT 'other',
  storage_backend TEXT NOT NULL,
  storage_key TEXT,
  data BYTEA,
  content_type VARCHAR(255) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  portal_visible BOOLEAN NOT NULL DEFAULT FALSE,
  supersedes_document_id UUID,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_backend_chk
    CHECK (storage_backend IN ('s3','db'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A LIVE row carries its bytes in exactly one place. A soft-deleted row is
-- exempt: deleteDocument removes the object FIRST, then clears both pointers, so
-- the tombstone keeps its metadata while the customer bytes are genuinely gone.
DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_bytes_chk CHECK (
    deleted_at IS NOT NULL
    OR (storage_backend = 's3' AND storage_key IS NOT NULL AND data IS NULL)
    OR (storage_backend = 'db' AND data IS NOT NULL AND storage_key IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_byte_size_chk
    CHECK (byte_size > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_no_self_supersede_chk
    CHECK (supersedes_document_id IS NULL OR supersedes_document_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Composite self-FK: a document may only supersede one of the SAME org.
-- DEFERRABLE INITIALLY IMMEDIATE — it references an org_id column, and the org
-- merge re-points parent and child in separate statements (CLAUDE.md contract).
CREATE UNIQUE INDEX IF NOT EXISTS org_documents_id_org_uq ON org_documents (id, org_id);
DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_supersedes_org_fk
    FOREIGN KEY (supersedes_document_id, org_id) REFERENCES org_documents(id, org_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One successor per document: the chain is a list, never a tree.
CREATE UNIQUE INDEX IF NOT EXISTS org_documents_supersedes_uq
  ON org_documents (supersedes_document_id) WHERE supersedes_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS org_documents_org_category_idx ON org_documents (org_id, category);
CREATE INDEX IF NOT EXISTS org_documents_org_created_idx ON org_documents (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS org_documents_org_portal_idx
  ON org_documents (org_id) WHERE portal_visible AND deleted_at IS NULL;

-- RLS: shape 1 (direct org_id).
ALTER TABLE org_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON org_documents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON org_documents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON org_documents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON org_documents;
CREATE POLICY breeze_org_isolation_select ON org_documents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON org_documents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON org_documents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON org_documents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- W01 created service_deliverable_evidence.document_id without an FK because
-- org_documents did not exist yet (spec §4.3). Close it now.
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_document_org_fk
    FOREIGN KEY (document_id, org_id) REFERENCES org_documents(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
