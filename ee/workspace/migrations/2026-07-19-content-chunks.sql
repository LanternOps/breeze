-- 2026-07-19: Workspace content phase, part 2 — vector chunks (dev-preview).
-- SPLIT from 2026-07-19-content.sql deliberately: this file hard-requires the
-- pgvector extension (pgvector/pgvector image swap, verified on the dev and
-- test stacks 2026-07-18). CREATE EXTENSION vector fails on plain postgres —
-- do not merge this into an environment whose image has not been swapped.
-- RLS shape 1; org cascade registered in breeze-extension.json.
-- Idempotent; autoMigrate wraps the file in a transaction — no inner BEGIN/COMMIT.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS workspace_content_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  file_index_id uuid NOT NULL REFERENCES workspace_file_index(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  embedding vector(1024),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_content_chunks_file_chunk_unique
  ON workspace_content_chunks(file_index_id, chunk_index);
CREATE INDEX IF NOT EXISTS wsp_content_chunks_org_idx ON workspace_content_chunks(org_id);
CREATE INDEX IF NOT EXISTS wsp_content_chunks_embedding_hnsw
  ON workspace_content_chunks USING hnsw (embedding vector_cosine_ops);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE workspace_content_chunks ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE workspace_content_chunks FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS breeze_org_isolation_select ON workspace_content_chunks';
  EXECUTE 'DROP POLICY IF EXISTS breeze_org_isolation_insert ON workspace_content_chunks';
  EXECUTE 'DROP POLICY IF EXISTS breeze_org_isolation_update ON workspace_content_chunks';
  EXECUTE 'DROP POLICY IF EXISTS breeze_org_isolation_delete ON workspace_content_chunks';
  EXECUTE 'CREATE POLICY breeze_org_isolation_select ON workspace_content_chunks FOR SELECT USING (public.breeze_has_org_access(org_id))';
  EXECUTE 'CREATE POLICY breeze_org_isolation_insert ON workspace_content_chunks FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))';
  EXECUTE 'CREATE POLICY breeze_org_isolation_update ON workspace_content_chunks FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))';
  EXECUTE 'CREATE POLICY breeze_org_isolation_delete ON workspace_content_chunks FOR DELETE USING (public.breeze_has_org_access(org_id))';
END $$;
