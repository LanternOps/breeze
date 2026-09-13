-- apps/api/migrations/2026-10-16-180400-ai-run-artifacts.sql
-- AI execution plane W01 — artifact store (spec
-- docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md
-- §5.2, §6.1, §8). Drizzle mirror: src/db/schema/aiWorkspace.ts.
--
-- One new Shape-1 tenant table. DDL only: this file writes no rows, so it
-- elects no `breeze.scope` (any future DML here must
-- `SELECT set_config('breeze.scope','system',true)` FIRST — see
-- src/db/migrationRlsScope.test.ts).
--
-- Design points, each traceable to the spec:
--
--  1. `run_id` is NULLABLE (chat-session captures have no run, §5.4). The
--     composite FK `(run_id, org_id) -> ai_agent_runs(id, org_id)` is MATCH
--     SIMPLE — unchecked while run_id is NULL, binding otherwise — and is
--     DEFERRABLE INITIALLY IMMEDIATE because org merge runs `SET CONSTRAINTS
--     ALL DEFERRED` and re-points parent and child org_id in separate
--     statements (orgLifecycleFoundations.integration.test.ts). ON DELETE
--     CASCADE: an artifact is meaningless without its run.
--  2. Its target `ai_agent_runs_id_org_uq UNIQUE (id, org_id)` already
--     exists, so section 0's guarded ADD CONSTRAINT is a defensive no-op — it
--     is there for a from-scratch replay, never for a live DB.
--  3. `source_device_id`, never `device_id` (§6.1): artifacts outlive the
--     device and must NOT be enrolled in the device cascade / move-org lists,
--     which key on a `device_id` column. ON DELETE SET NULL.
--  4. `kind` is a real ENUM: it is never an index column, so the
--     leakproof-operator concern that makes state columns text+CHECK
--     elsewhere does not apply.
--  5. `blob_key` carries NO tenant identifier (§5.2, §8); the row is the only
--     index to the blob, so every delete path removes the blob FIRST.
--  6. Previews are bounded text (<= 2048 chars), not jsonb — every column here
--     is exportable `included`; nothing open-ended lives in the row.
--
-- Idempotent throughout; autoMigrate wraps this file in one transaction —
-- no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 0. Enum + composite FK target on ai_agent_runs
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE ai_artifact_kind AS ENUM ('input_capture', 'step_script', 'step_stdout', 'output', 'report');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ai_agent_runs'::regclass
      AND conname IN ('ai_agent_runs_id_org_uq', 'ai_agent_runs_id_org_id_key')
  ) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_id_org_uq UNIQUE (id, org_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. ai_run_artifacts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_run_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  run_id uuid,
  session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  kind ai_artifact_kind NOT NULL,
  name text NOT NULL
    CONSTRAINT ai_run_artifacts_name_len_chk CHECK (length(name) BETWEEN 1 AND 200),
  content_type text NOT NULL
    CONSTRAINT ai_run_artifacts_content_type_len_chk CHECK (length(content_type) BETWEEN 1 AND 128),
  bytes bigint NOT NULL
    CONSTRAINT ai_run_artifacts_bytes_chk CHECK (bytes >= 0),
  sha256 text NOT NULL
    CONSTRAINT ai_run_artifacts_sha256_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_key text NOT NULL
    CONSTRAINT ai_run_artifacts_blob_key_len_chk CHECK (length(blob_key) BETWEEN 1 AND 256),
  head_preview text NOT NULL DEFAULT ''
    CONSTRAINT ai_run_artifacts_head_preview_len_chk CHECK (length(head_preview) <= 2048),
  tail_preview text NOT NULL DEFAULT ''
    CONSTRAINT ai_run_artifacts_tail_preview_len_chk CHECK (length(tail_preview) <= 2048),
  source_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_by_tool text NOT NULL
    CONSTRAINT ai_run_artifacts_created_by_tool_len_chk CHECK (length(created_by_tool) BETWEEN 1 AND 128),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_run_artifacts DROP CONSTRAINT IF EXISTS ai_run_artifacts_run_org_fk;
ALTER TABLE ai_run_artifacts ADD CONSTRAINT ai_run_artifacts_run_org_fk
  FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS ai_run_artifacts_org_run_idx ON ai_run_artifacts (org_id, run_id);
CREATE INDEX IF NOT EXISTS ai_run_artifacts_org_expires_idx ON ai_run_artifacts (org_id, expires_at);
CREATE INDEX IF NOT EXISTS ai_run_artifacts_org_source_device_idx ON ai_run_artifacts (org_id, source_device_id);
-- Sweeper scan is cross-org under system scope (jobs/aiArtifactSweeper.ts).
CREATE INDEX IF NOT EXISTS ai_run_artifacts_expires_idx ON ai_run_artifacts (expires_at);

-- ---------------------------------------------------------------------------
-- 2. RLS — Shape 1, same idiom as action_intents / ai_operator_tasks.
-- breeze_has_org_access() returns TRUE for system scope internally, so there
-- is no separate system branch.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run_artifacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_run_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_run_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_run_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_run_artifacts;

CREATE POLICY breeze_org_isolation_select ON ai_run_artifacts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_run_artifacts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_run_artifacts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_run_artifacts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_run_artifacts TO breeze_app;
