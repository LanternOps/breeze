-- 2026-07-10: Breeze Workspace extension foundation (phase 1).
-- Four org-scoped (RLS shape 1) tables:
--   workspace_sources        — indexed source roots (SMB shares / local profiles)
--   workspace_file_index     — file + directory metadata index (is_dir/parent_path serve the browser view)
--   workspace_file_activity  — per-user open/reveal/copy events (recents + department views)
--   memory_blocks            — Wick-shaped memory foundation (agents author; humans confirm/correct/retract)
-- Tenancy: all four carry org_id → auto-discovered by the RLS coverage contract
-- test; cascade/move registration via breeze-extension.json tenancy block.
-- Device FKs use ON DELETE SET NULL (detach) as of this phase — superseded for
-- workspace_file_index.device_id (CASCADE + manifest deviceCascadeDeleteTables
-- entry) in 2026-07-12-crawler.sql.
-- Idempotent; autoMigrate wraps the file in a transaction — no inner BEGIN/COMMIT.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_source_kind') THEN
    CREATE TYPE workspace_source_kind AS ENUM ('smb_share', 'local_profile');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_source_status') THEN
    CREATE TYPE workspace_source_status AS ENUM ('active', 'paused', 'error');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_file_action') THEN
    CREATE TYPE workspace_file_action AS ENUM ('open', 'reveal', 'copy_path');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind workspace_source_kind NOT NULL,
  display_name text NOT NULL,
  root_path text NOT NULL,
  crawl_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  visibility_group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_ref uuid,
  crawl_cadence_minutes integer NOT NULL DEFAULT 360,
  crawl_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  status workspace_source_status NOT NULL DEFAULT 'active',
  status_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wsp_sources_org_idx ON workspace_sources(org_id);

CREATE TABLE IF NOT EXISTS workspace_file_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_id uuid NOT NULL REFERENCES workspace_sources(id) ON DELETE CASCADE,
  rel_path text NOT NULL,
  parent_path text NOT NULL DEFAULT '',
  name text NOT NULL,
  is_dir boolean NOT NULL DEFAULT false,
  ext text,
  mime text,
  size bigint,
  mtime timestamptz,
  ctime timestamptz,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wsp_file_index_unique ON workspace_file_index(org_id, source_id, rel_path);
CREATE INDEX IF NOT EXISTS wsp_file_index_parent_idx ON workspace_file_index(org_id, source_id, parent_path);
CREATE INDEX IF NOT EXISTS wsp_file_index_org_idx ON workspace_file_index(org_id);
-- Trigram search indexes require pg_extension pg_trgm; create extension only if
-- available (managed PG has it), skip with a RAISE WARNING otherwise (phase 3
-- hard-requires it).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS wsp_file_index_name_trgm ON workspace_file_index USING gin (name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS wsp_file_index_path_trgm ON workspace_file_index USING gin (rel_path gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE WARNING 'pg_trgm unavailable — skipping trigram indexes (search phase requires them)';
END $$;

CREATE TABLE IF NOT EXISTS workspace_file_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_index_id uuid NOT NULL REFERENCES workspace_file_index(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  action workspace_file_action NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wsp_file_activity_org_user_idx ON workspace_file_activity(org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wsp_file_activity_device_idx ON workspace_file_activity(device_id);

-- memory_blocks: Wick's exact shape (see internal/specs/2026-06-13 §5).
-- Agents author; humans confirm/correct/retract. No actor column by design
-- ("track work, not workers") — the subject lives in subject_key.
CREATE TABLE IF NOT EXISTS memory_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  partner_id uuid,
  block_type varchar(64) NOT NULL,
  subject_key varchar(280) NOT NULL,
  content jsonb NOT NULL,
  confidence varchar(16) NOT NULL DEFAULT 'medium',
  authored_by_run_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  retracted_at timestamptz,
  superseded_by_id uuid REFERENCES memory_blocks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_blocks_org_subject_idx ON memory_blocks(org_id, subject_key);

-- RLS: shape 1 (direct org_id) on all four tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_sources','workspace_file_index','workspace_file_activity','memory_blocks']
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
