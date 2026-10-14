-- Trust Center W1 (spec docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md §7, §9).
-- Shape 1 (direct org_id) for all three tables. org_id NOT NULL is justified in
-- spec §9: a trust page is one org's public identity, not an inheritable policy.
-- partner_id is denormalized for the partner-home uniqueness and proven by the
-- composite FK to organizations(id, partner_id), DEFERRABLE INITIALLY IMMEDIATE
-- (org merge runs SET CONSTRAINTS ALL DEFERRED). RLS stays org-only.
-- There is deliberately NO FK from trust_pages back to trust_page_snapshots: a
-- current_snapshot_id pointer would make the pair a cycle and abort org erasure.
-- Registered in CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry (trust_pages:
-- custom executor; children: repoint) and CORE_TENANT_EXPORT_POLICY.
-- DDL only: no rows written, so no breeze.scope election.

DO $$ BEGIN
  CREATE TYPE trust_page_document_visibility AS ENUM ('public', 'gated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS trust_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL UNIQUE REFERENCES organizations(id),
  partner_id UUID NOT NULL REFERENCES partners(id),
  is_partner_home BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  publication_revision INTEGER NOT NULL DEFAULT 0,
  search_indexable BOOLEAN NOT NULL DEFAULT FALSE,
  show_percentages BOOLEAN NOT NULL DEFAULT FALSE,
  show_device_count BOOLEAN NOT NULL DEFAULT FALSE,
  show_managed_by BOOLEAN NOT NULL DEFAULT TRUE,
  security_contact_email VARCHAR(320),
  website_url TEXT,
  intro_html TEXT,
  hidden_control_ids TEXT[] NOT NULL DEFAULT '{}',
  publication_authorized_by VARCHAR(200),
  publication_authorized_at TIMESTAMPTZ,
  publication_authorized_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_evaluated_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Frozen publication config (spec §19 item 17): written by publish, read by the
-- hourly refresh, so draft edits never reach the public page without a publish.
-- ADD COLUMN IF NOT EXISTS so a database that ran an earlier draft of this
-- (unshipped) file converges.
ALTER TABLE trust_pages ADD COLUMN IF NOT EXISTS published_config JSONB;

-- Bounds the SANITIZED intro: TRUST_INTRO_STORED_MAX_CHARS = TRUST_INTRO_MAX_CHARS * 8
-- = 40,000 (packages/shared/src/validators/trustCenter.ts) — change both together.
-- Drop + re-add so a database holding the earlier 20,000 bound converges.
ALTER TABLE trust_pages DROP CONSTRAINT IF EXISTS trust_pages_intro_len_chk;
ALTER TABLE trust_pages ADD CONSTRAINT trust_pages_intro_len_chk
  CHECK (intro_html IS NULL OR length(intro_html) <= 40000);

-- Target for the children's composite FKs.
CREATE UNIQUE INDEX IF NOT EXISTS trust_pages_id_org_uq ON trust_pages (id, org_id);
-- One partner-home page per partner.
CREATE UNIQUE INDEX IF NOT EXISTS trust_pages_partner_home_uq
  ON trust_pages (partner_id) WHERE is_partner_home;
-- The hourly refresh walks published pages.
CREATE INDEX IF NOT EXISTS trust_pages_published_idx
  ON trust_pages (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS trust_page_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_page_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  payload JSONB NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  catalog_version TEXT NOT NULL,
  publication_revision INTEGER NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE trust_page_snapshots ADD CONSTRAINT trust_page_snapshots_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trust_page_snapshots_current_uq
  ON trust_page_snapshots (trust_page_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS trust_page_snapshots_page_generated_idx
  ON trust_page_snapshots (trust_page_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS trust_page_snapshots_prune_idx
  ON trust_page_snapshots (generated_at) WHERE NOT is_current;

-- Snapshots are immutable except for is_current (spec §9) and org_id (the org
-- merge's buildRepoint may re-stamp children; the payload itself never changes).
CREATE OR REPLACE FUNCTION trust_page_snapshots_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.trust_page_id IS DISTINCT FROM OLD.trust_page_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.catalog_version IS DISTINCT FROM OLD.catalog_version
     OR NEW.publication_revision IS DISTINCT FROM OLD.publication_revision
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION 'trust_page_snapshots rows are immutable (only is_current and org_id may change)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trust_page_snapshots_immutable_trg ON trust_page_snapshots;
CREATE TRIGGER trust_page_snapshots_immutable_trg
  BEFORE UPDATE ON trust_page_snapshots
  FOR EACH ROW EXECUTE FUNCTION trust_page_snapshots_immutable();

CREATE TABLE IF NOT EXISTS trust_page_documents (
  trust_page_id UUID NOT NULL,
  document_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  visibility trust_page_document_visibility NOT NULL DEFAULT 'public',
  disclosure_confirmed_at TIMESTAMPTZ,
  disclosure_confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trust_page_id, document_id)
);

DO $$ BEGIN
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_page_org_fk
    FOREIGN KEY (trust_page_id, org_id) REFERENCES trust_pages(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_document_org_fk
    FOREIGN KEY (document_id, org_id) REFERENCES org_documents(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A public document must carry its disclosure confirmation (spec §12).
DO $$ BEGIN
  ALTER TABLE trust_page_documents ADD CONSTRAINT trust_page_documents_public_confirmed_chk
    CHECK (visibility <> 'public' OR disclosure_confirmed_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS trust_page_documents_org_idx ON trust_page_documents (org_id);

-- RLS: shape 1 (direct org_id) on all three tables.
ALTER TABLE trust_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_pages;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_pages;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_pages;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_pages;
CREATE POLICY breeze_org_isolation_select ON trust_pages FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_pages FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_pages FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_pages FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_snapshots;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_snapshots;
CREATE POLICY breeze_org_isolation_select ON trust_page_snapshots FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_snapshots FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_snapshots FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_snapshots FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE trust_page_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_page_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON trust_page_documents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON trust_page_documents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON trust_page_documents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON trust_page_documents;
CREATE POLICY breeze_org_isolation_select ON trust_page_documents FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON trust_page_documents FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON trust_page_documents FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON trust_page_documents FOR DELETE USING (public.breeze_has_org_access(org_id));
