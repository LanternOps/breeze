-- 2026-07-19: Workspace content phase, part 1 (dev-preview; lexical/entity layer).
-- Six org-scoped (RLS shape 1) tables:
--   workspace_file_content      — per-file extracted text + idempotency snapshot + FTS
--   workspace_content_entities  — deterministic (regex) + LLM person/org entity index
--   workspace_file_enrichment   — LLM-inferred metadata; declared vs inferred side-by-side
--   workspace_projects          — per-org project registry (key, label, aliases)
--   workspace_project_crosswalk — counterparty IDs mined from filed project documents/email
--   workspace_email_filings     — classify-one-email suggestions + human decisions
-- The vector/chunks table lands in a LATER migration (requires the pgvector
-- image on every stack; this file must apply cleanly on plain postgres).
--
-- Preview scope: all writers/readers of these tables sit behind the
-- WORKSPACE_CONTENT_PREVIEW env flag (default off; never on in production).
-- DLP-on-ingest is explicitly DEFERRED to the Knowledge phase (spec
-- 2026-07-09 §12 phase 6): extracted_text is stored without content
-- inspection/redaction. Nothing in this preview claims DLP or governance.
-- Idempotent; autoMigrate wraps the file in a transaction — no inner BEGIN/COMMIT.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_content_status') THEN
    CREATE TYPE workspace_content_status AS ENUM ('extracted', 'failed', 'skipped_too_large', 'skipped_binary');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_filing_status') THEN
    CREATE TYPE workspace_filing_status AS ENUM ('suggested', 'confirmed', 'reassigned');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_filing_confidence') THEN
    CREATE TYPE workspace_filing_confidence AS ENUM ('high', 'low');
  END IF;
END $$;

-- Extraction state. "Pending" is the ABSENCE of a row (or a stale
-- source_size/source_mtime snapshot vs workspace_file_index) — no pending enum
-- value, so re-crawls never need a backfill pass here.
CREATE TABLE IF NOT EXISTS workspace_file_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  file_index_id uuid NOT NULL REFERENCES workspace_file_index(id) ON DELETE CASCADE,
  content_hash text,
  source_size bigint,
  source_mtime timestamptz,
  extracted_text text,
  status workspace_content_status NOT NULL,
  error_reason text,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_file_content_file_unique ON workspace_file_content(file_index_id);
CREATE INDEX IF NOT EXISTS wsp_file_content_org_idx ON workspace_file_content(org_id);
CREATE INDEX IF NOT EXISTS wsp_file_content_fts_idx
  ON workspace_file_content USING gin (to_tsvector('english', coalesce(extracted_text, '')));

-- Entity index. Deterministic regex pass owns the structured types
-- (apn/po/wdr/invoice/permit/job); the LLM pass may only add person/org rows.
-- value_norm is the canonical form (uppercased, '#'/whitespace stripped) —
-- query-side detection MUST normalize identically (src/content/entities.ts).
CREATE TABLE IF NOT EXISTS workspace_content_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  file_index_id uuid NOT NULL REFERENCES workspace_file_index(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  value_norm text NOT NULL,
  value_raw text,
  origin text NOT NULL DEFAULT 'regex',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_content_entities_unique
  ON workspace_content_entities(org_id, file_index_id, entity_type, value_norm);
CREATE INDEX IF NOT EXISTS wsp_content_entities_lookup_idx
  ON workspace_content_entities(org_id, entity_type, value_norm);
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS wsp_content_entities_value_trgm
    ON workspace_content_entities USING gin (value_norm gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE WARNING 'pg_trgm unavailable — skipping entity trigram index';
END $$;

-- Inferred metadata (LLM) next to the declared location (derived from
-- rel_path) so the finder can SHOW disagreement rather than silently "fix" it.
-- email_meta is written by the mailparser extraction step, never by the LLM.
CREATE TABLE IF NOT EXISTS workspace_file_enrichment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  file_index_id uuid NOT NULL REFERENCES workspace_file_index(id) ON DELETE CASCADE,
  inferred_project_key text,
  inferred_project_label text,
  inferred_doc_type text,
  doc_date date,
  declared_project_key text,
  declared_project_label text,
  email_meta jsonb,
  confidence varchar(16),
  model text,
  enriched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_file_enrichment_file_unique ON workspace_file_enrichment(file_index_id);
CREATE INDEX IF NOT EXISTS wsp_file_enrichment_org_idx ON workspace_file_enrichment(org_id);
CREATE INDEX IF NOT EXISTS wsp_file_enrichment_inferred_project_idx
  ON workspace_file_enrichment(org_id, inferred_project_key);

-- Project registry, derived from declared folder structure during ingest.
CREATE TABLE IF NOT EXISTS workspace_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  project_key text NOT NULL,
  label text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_projects_org_key_unique ON workspace_projects(org_id, project_key);
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS wsp_projects_label_trgm
    ON workspace_projects USING gin (label gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE WARNING 'pg_trgm unavailable — skipping project label trigram index';
END $$;

-- Crosswalk: which counterparty identifier (PO/WDR/invoice/permit) belongs to
-- which project, mined from documents/email already filed under a declared
-- project. evidence_count counts DISTINCT files, never mentions.
CREATE TABLE IF NOT EXISTS workspace_project_crosswalk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  entity_type text NOT NULL,
  value_norm text NOT NULL,
  project_key text NOT NULL,
  project_label text,
  evidence_count integer NOT NULL DEFAULT 0,
  sample_file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  mined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_project_crosswalk_unique
  ON workspace_project_crosswalk(org_id, entity_type, value_norm, project_key);
CREATE INDEX IF NOT EXISTS wsp_project_crosswalk_org_idx ON workspace_project_crosswalk(org_id);

-- Filing suggestions + decisions for unfiled email. decided_label is the
-- device-local helper display label (matches workspace_file_activity.helper_user
-- semantics) — never an authorization input, no user FK by design.
CREATE TABLE IF NOT EXISTS workspace_email_filings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  file_index_id uuid NOT NULL REFERENCES workspace_file_index(id) ON DELETE CASCADE,
  status workspace_filing_status NOT NULL DEFAULT 'suggested',
  suggested_project_key text,
  suggested_project_label text,
  matched_entity_type text,
  matched_entity_value text,
  confidence workspace_filing_confidence NOT NULL DEFAULT 'low',
  rationale text,
  decided_project_key text,
  decided_label varchar(100),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_email_filings_file_unique ON workspace_email_filings(file_index_id);
CREATE INDEX IF NOT EXISTS wsp_email_filings_org_status_idx ON workspace_email_filings(org_id, status);

-- RLS: shape 1 (direct org_id) on all six tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_file_content','workspace_content_entities','workspace_file_enrichment',
    'workspace_projects','workspace_project_crosswalk','workspace_email_filings'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_select ON %I FOR SELECT USING (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON %I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_update ON %I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON %I FOR DELETE USING (public.breeze_has_org_access(org_id))', t);
  END LOOP;
END $$;
