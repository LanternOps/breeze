-- W3: productized ingest — delta-triggered incremental ingest job state.
-- One live job per (org, source-partition); advancement is in-request batch
-- continuation (see src/services/ingestJobRunner.ts). RLS shape 1; registered
-- in breeze-extension.json orgCascadeDeleteTables.
-- autoMigrate wraps this file in a transaction: CREATE TYPE is safe here
-- (only ALTER TYPE ADD VALUE is not — see 2026-07-24-org-settings-dlp.sql:23-26).

DO $$ BEGIN
  CREATE TYPE workspace_ingest_trigger AS ENUM ('crawl_complete', 'manual', 'reingest');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workspace_ingest_phase AS ENUM ('ingest', 'enrich', 'crosswalk');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workspace_ingest_job_status AS ENUM ('pending', 'running', 'complete', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS workspace_ingest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_id uuid REFERENCES workspace_sources(id) ON DELETE CASCADE,
  crawl_run_id uuid REFERENCES workspace_crawl_runs(id) ON DELETE SET NULL,
  trigger workspace_ingest_trigger NOT NULL,
  phase workspace_ingest_phase NOT NULL DEFAULT 'ingest',
  status workspace_ingest_job_status NOT NULL DEFAULT 'pending',
  force boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  cursor text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wsp_ingest_jobs_org_status_idx
  ON workspace_ingest_jobs (org_id, status, next_attempt_at);

-- One live job per org+source partition. Zero-uuid stands in for org-wide
-- (source_id IS NULL), mirroring the device_key COALESCE idiom (runScope.ts:9-15).
CREATE UNIQUE INDEX IF NOT EXISTS wsp_ingest_jobs_one_active_idx
  ON workspace_ingest_jobs (org_id, COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending', 'running');

DO $$
BEGIN
  ALTER TABLE workspace_ingest_jobs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE workspace_ingest_jobs FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS breeze_org_isolation_select ON workspace_ingest_jobs;
  DROP POLICY IF EXISTS breeze_org_isolation_insert ON workspace_ingest_jobs;
  DROP POLICY IF EXISTS breeze_org_isolation_update ON workspace_ingest_jobs;
  DROP POLICY IF EXISTS breeze_org_isolation_delete ON workspace_ingest_jobs;
  CREATE POLICY breeze_org_isolation_select ON workspace_ingest_jobs FOR SELECT USING (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_insert ON workspace_ingest_jobs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_update ON workspace_ingest_jobs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_delete ON workspace_ingest_jobs FOR DELETE USING (public.breeze_has_org_access(org_id));
END $$;
