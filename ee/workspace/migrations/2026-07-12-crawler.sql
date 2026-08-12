-- 2026-07-12: Breeze Workspace extension crawler foundation (phase 2).
-- Adds org-scoped crawl runs, a device dimension to the file index, and
-- crawler credential/configuration fields to workspace sources.
-- Tenancy: workspace_crawl_runs carries org_id and uses RLS shape 1.
-- Device FKs: crawl_runs detach (SET NULL, history); file_index rows CASCADE
-- with their device (deliberate deviation from phase 1 — see inline comment).
-- Idempotent; autoMigrate wraps the file in a transaction — no inner BEGIN/COMMIT.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_crawl_status') THEN
    CREATE TYPE workspace_crawl_status AS ENUM ('running', 'complete', 'failed', 'abandoned');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_crawl_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_id uuid NOT NULL REFERENCES workspace_sources(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  device_key uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  status workspace_crawl_status NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cursor text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_reason text
);
CREATE INDEX IF NOT EXISTS wsp_crawl_runs_org_source_status_idx
  ON workspace_crawl_runs(org_id, source_id, status);

-- CASCADE (not the phase-1 SET NULL convention) is deliberate: a deleted
-- device's local_profile rows are unreachable garbage and must go with it,
-- and device_key (COALESCE(device_id, zero-uuid)) must never go stale.
ALTER TABLE workspace_file_index
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE workspace_file_index
  ADD COLUMN IF NOT EXISTS device_key uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
DO $$
DECLARE updated_count bigint;
BEGIN
  UPDATE workspace_file_index
  SET device_key = COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid)
  WHERE device_key IS DISTINCT FROM COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count > 0 THEN
    RAISE WARNING 'aligned % workspace_file_index device keys', updated_count;
  END IF;
END $$;
DROP INDEX IF EXISTS wsp_file_index_unique;
CREATE UNIQUE INDEX IF NOT EXISTS wsp_file_index_org_source_device_rel_path_unique
  ON workspace_file_index(org_id, source_id, device_key, rel_path);

ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS credential_enc text;
ALTER TABLE workspace_sources DROP COLUMN IF EXISTS credential_ref;
ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS exclude_globs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS watch boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS error_reason text;
ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS last_complete_run_at timestamptz;

-- RLS: shape 1 (direct org_id) on workspace_crawl_runs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_crawl_runs']
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
