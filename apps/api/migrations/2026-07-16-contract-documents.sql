-- Contract template library + executed contract documents (spec:
-- docs/superpowers/specs/2026-07-16-contract-documents-and-enhanced-proposals-design.md).
--
-- contract_templates / contract_template_versions are PARTNER-WIDE-FIRST config
-- tables (epic #2135 shape): org_id XOR partner_id, one dual-axis RLS policy,
-- mirroring 2026-07-01-software-policies-partner-ownership.sql. Versions
-- denormalize the owner axes from their template (FK children get NO RLS
-- coverage for free); the owner (org_id/partner_id) is unconditionally
-- immutable post-create — updateTemplate only ever touches name/description —
-- so the denorm cannot drift. contract_documents is an org-owned transactional
-- record (executed instance for a specific client org — org_id NOT NULL is
-- deliberate, not an oversight); it uses the shape-1 (direct org_id) RLS
-- idiom, matching 2026-06-16-quotes.sql / 2026-06-15-c-invoice-documents.sql
-- (four per-command breeze_org_isolation_* policies, no explicit system-scope
-- branch — breeze_has_org_access() already returns TRUE under system scope;
-- the explicit branch is only needed on dual-axis tables where the policy's
-- own `org_id IS NOT NULL` guard would otherwise block that short-circuit for
-- partner-owned rows). service_principals is NOT the same shape here — it
-- uses a single combined USING/WITH CHECK policy rather than four per-command
-- ones.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- Step 1: quote-side additions ------------------------------------------------
ALTER TYPE quote_block_type ADD VALUE IF NOT EXISTS 'contract';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cover_page jsonb;

-- Step 2: enums ---------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE contract_template_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE contract_template_version_status AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE contract_template_source_type AS ENUM ('authored', 'uploaded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Step 3: contract_templates --------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  name varchar(255) NOT NULL,
  description text,
  status contract_template_status NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT contract_templates_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);
CREATE INDEX IF NOT EXISTS contract_templates_partner_id_idx ON contract_templates(partner_id);
CREATE INDEX IF NOT EXISTS contract_templates_org_id_idx ON contract_templates(org_id);

-- Step 4: contract_template_versions -------------------------------------------
CREATE TABLE IF NOT EXISTS contract_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  version_number integer NOT NULL,
  status contract_template_version_status NOT NULL DEFAULT 'draft',
  source_type contract_template_source_type NOT NULL,
  body_html text,
  file_data bytea,
  mime varchar(64),
  byte_size integer,
  sha256 char(64),
  declared_variables jsonb NOT NULL DEFAULT '[]',
  published_at timestamp,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT contract_template_versions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT contract_template_versions_body_chk CHECK (
    (source_type = 'authored' AND body_html IS NOT NULL)
    OR (source_type = 'uploaded' AND file_data IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_template_versions_template_version_uq
  ON contract_template_versions(template_id, version_number);
CREATE INDEX IF NOT EXISTS contract_template_versions_partner_id_idx ON contract_template_versions(partner_id);
CREATE INDEX IF NOT EXISTS contract_template_versions_org_id_idx ON contract_template_versions(org_id);

-- Step 5: contract_documents ---------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  quote_acceptance_id uuid REFERENCES quote_acceptances(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
  template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE RESTRICT,
  template_version_id uuid NOT NULL REFERENCES contract_template_versions(id) ON DELETE RESTRICT,
  rendered_html text,
  pdf_data bytea NOT NULL,
  mime varchar(64) NOT NULL DEFAULT 'application/pdf',
  byte_size integer NOT NULL,
  sha256 char(64) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_documents_org_idx ON contract_documents(org_id);
CREATE INDEX IF NOT EXISTS contract_documents_contract_idx ON contract_documents(contract_id);
CREATE INDEX IF NOT EXISTS contract_documents_quote_idx ON contract_documents(quote_id);

-- Step 6: RLS -------------------------------------------------------------------
-- contract_templates / contract_template_versions: dual-axis (org OR partner),
-- single combined policy per table, matching the software_policies precedent.
ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_templates_isolation ON contract_templates;
CREATE POLICY contract_templates_isolation ON contract_templates
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE contract_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_template_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_template_versions_isolation ON contract_template_versions;
CREATE POLICY contract_template_versions_isolation ON contract_template_versions
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- contract_documents: shape 1 (direct org_id, always NOT NULL). Four
-- per-command policies, matching quotes.sql / invoice_documents.sql — NOT the
-- dual-axis single-policy shape above, and NOT service_principals (which uses
-- one combined USING/WITH CHECK policy instead of four per-command ones) —
-- since there is only one ownership axis here and breeze_has_org_access()
-- already resolves system scope internally.
ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_documents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_documents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_documents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_documents;
CREATE POLICY breeze_org_isolation_select ON contract_documents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_documents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_documents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_documents
  FOR DELETE USING (public.breeze_has_org_access(org_id));
