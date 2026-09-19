-- 2026-10-16: AI execution plane W02 — ai_run_workspaces + compute columns.
--
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md
--       §6 (preamble: tenancy contract), §6.2 (this table), §6.3 (compute
--       columns on four existing tables), §5.6 (metering), §5.8 (step
--       transcript), §8 (residency), §9 (destroy_failed).
--
-- DDL ONLY. This file creates a table, adds columns and adds constraints; it
-- issues no UPDATE/DELETE/INSERT/MERGE, so it elects no `breeze.scope`
-- (`ADD COLUMN ... DEFAULT` is DDL, not DML). Any FUTURE migration in this
-- family that writes rows MUST put
--   SELECT set_config('breeze.scope','system',true);
-- before its first write — 425 of 442 tables are FORCE ROW LEVEL SECURITY,
-- which binds the owner role migrations run as, so without it an UPDATE
-- silently matches zero rows and an INSERT aborts with 42501. Enforced by
-- apps/api/src/db/migrationRlsScope.test.ts.
--
-- Design points, each traceable to a contract:
--
--  1. `backend`, `status` and `region` are `text` + CHECK, never pgEnum. Under
--     FORCE ROW LEVEL SECURITY only leakproof operators become index
--     conditions; enum equality is not leakproof, so an enum `status` would
--     demote the reaper's once-a-minute poll to a post-policy filter over the
--     whole table (2026-10-14-100000 header note 1; the 2026-09-03 US
--     device-feed incident).
--
--  2. Partial-index predicates are literal constants, never parameters, so the
--     planner's predicate proof can see them (same header, note 2).
--
--  3. The composite `(run_id, org_id) -> ai_agent_runs(id, org_id)` FK is
--     DEFERRABLE INITIALLY IMMEDIATE. Org merge runs `SET CONSTRAINTS ALL
--     DEFERRED` and re-points parent and child `org_id` in separate
--     statements; a non-deferrable composite aborts the merge with 23503
--     (orgLifecycleFoundations.integration.test.ts, Integration shard 2).
--
--  4. `ai_agent_runs.workspace_id` gets NO foreign key. A real FK in both
--     directions would be a 2-node cycle that tenantCascade.ts's
--     topologicalCascadeOrder() cannot resolve — the exact
--     `metric_anomaly_incidents.agent_run_id` precedent. The constrained edge
--     is `ai_run_workspaces.run_id`; `workspace_id` is a plain pointer.
--
--  5. `ai_run_workspaces.provider_ref` is the VENDOR's sandbox id and is what
--     the reaper needs to destroy a sandbox whose worker process has died. It
--     is opaque and carries no tenant identifier (services/workspace/
--     vercelSandboxBackend.ts generates `breeze-<region>-<uuid>`), the same
--     rule the artifact blob keys follow.
--
--  6. `compute_cents` columns are added to ai_agent_runs (int), ai_cost_usage
--     (real) and ai_sessions (real). The int/real split is not an oversight:
--     it mirrors the existing `cost_cents int` on ai_agent_runs versus
--     `total_cost_cents real` on ai_cost_usage/ai_sessions, so the new column
--     has the same type as the token column it sits beside on each table.
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT/POLICY IF EXISTS before each ADD/CREATE. autoMigrate
-- wraps this file in one transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. ai_run_workspaces
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_run_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  run_id uuid NOT NULL,

  backend text NOT NULL
    CONSTRAINT ai_run_workspaces_backend_chk
    CHECK (backend IN ('vercel', 'gvisor_pool', 'agentcore', 'fake')),

  provider_ref text NOT NULL
    CONSTRAINT ai_run_workspaces_provider_ref_len_chk CHECK (length(provider_ref) <= 200),

  region text NOT NULL
    CONSTRAINT ai_run_workspaces_region_chk CHECK (region IN ('eu', 'us')),

  bootstrap_hash text
    CONSTRAINT ai_run_workspaces_bootstrap_hash_len_chk CHECK (bootstrap_hash IS NULL OR length(bootstrap_hash) <= 128),

  status text NOT NULL DEFAULT 'creating'
    CONSTRAINT ai_run_workspaces_status_chk
    CHECK (status IN ('creating', 'ready', 'destroying', 'destroyed', 'destroy_failed')),

  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  -- Stamped when the reaper claims a row (status -> 'destroying'). A claimed
  -- row is invisible to every later claim query, so if the claiming process
  -- dies before it destroys the sandbox, nothing would ever look at the row
  -- again and the sandbox would bill forever, unwatched and unpaged. The reaper
  -- reclaims a 'destroying' row older than this stamp + its stall window.
  destroying_since timestamptz,
  destroyed_at timestamptz,
  deadline_at timestamptz NOT NULL,

  cpu_ms bigint CONSTRAINT ai_run_workspaces_cpu_ms_chk CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  wall_ms bigint CONSTRAINT ai_run_workspaces_wall_ms_chk CHECK (wall_ms IS NULL OR wall_ms >= 0),
  mem_allocated_mb integer CONSTRAINT ai_run_workspaces_mem_chk CHECK (mem_allocated_mb IS NULL OR mem_allocated_mb >= 0),
  compute_cents integer CONSTRAINT ai_run_workspaces_compute_cents_chk CHECK (compute_cents IS NULL OR compute_cents >= 0),

  staged_bytes bigint NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_staged_bytes_chk CHECK (staged_bytes >= 0),
  artifact_bytes bigint NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_artifact_bytes_chk CHECK (artifact_bytes >= 0),
  step_count integer NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_step_count_chk CHECK (step_count >= 0),

  -- Step transcript (spec §5.8). jsonb, therefore `excludedOpen` in
  -- CORE_TENANT_EXPORT_POLICY — an open container may embed anything.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,

  destroy_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_destroy_attempts_chk CHECK (destroy_attempts >= 0),
  last_error text
    CONSTRAINT ai_run_workspaces_last_error_len_chk CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

-- Tenant FK. Deferrable (header note 3); CASCADE so an erased run takes its
-- workspace row with it.
ALTER TABLE ai_run_workspaces DROP CONSTRAINT IF EXISTS ai_run_workspaces_run_org_fk;
ALTER TABLE ai_run_workspaces ADD CONSTRAINT ai_run_workspaces_run_org_fk
  FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS ai_run_workspaces_org_run_idx
  ON ai_run_workspaces (org_id, run_id);

-- Spec §6.2: at most one LIVE workspace per run. Literal-constant predicate.
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_workspaces_org_run_live_uq
  ON ai_run_workspaces (org_id, run_id)
  WHERE status <> 'destroyed';

-- The reaper's poll (jobs/workspaceReaper.ts): oldest deadline first among
-- everything not yet destroyed. Literal-constant predicate, leakproof text
-- comparison, so it survives forced RLS as an index condition.
CREATE INDEX IF NOT EXISTS ai_run_workspaces_reaper_idx
  ON ai_run_workspaces (deadline_at)
  WHERE status <> 'destroyed';

ALTER TABLE ai_run_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run_workspaces FORCE ROW LEVEL SECURITY;

-- Shape 1: the canonical idiom is a plain breeze_has_org_access(org_id) with
-- NO separate system branch — the helper already returns TRUE for system scope
-- (0001-baseline.sql). Identical to ai_operator_tasks / action_intents.
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_run_workspaces;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_run_workspaces;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_run_workspaces;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_run_workspaces;

CREATE POLICY breeze_org_isolation_select ON ai_run_workspaces
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_run_workspaces
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_run_workspaces
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_run_workspaces
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_run_workspaces TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. ai_agent_runs — compute accounting (spec §6.3)
-- ---------------------------------------------------------------------------
--
-- `workspace_id` is deliberately FK-less (header note 4).

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_cpu_ms bigint;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_wall_ms bigint;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_cents integer;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_reserved_cents integer;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS workspace_id uuid;

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_compute_nonneg_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_compute_nonneg_chk CHECK (
  (compute_cpu_ms IS NULL OR compute_cpu_ms >= 0)
  AND (compute_wall_ms IS NULL OR compute_wall_ms >= 0)
  AND (compute_cents IS NULL OR compute_cents >= 0)
  AND (compute_reserved_cents IS NULL OR compute_reserved_cents >= 0)
);

-- ---------------------------------------------------------------------------
-- 3. ai_cost_usage / ai_sessions / ai_budgets (spec §6.3)
-- ---------------------------------------------------------------------------
--
-- `real` beside the existing `total_cost_cents real` on the two rollup tables;
-- `integer` beside `cost_cents integer` on the per-run table (header note 6).
-- NOT NULL DEFAULT 0 so every existing row reads as "no compute spent" rather
-- than NULL, which is the truth: nothing before this migration could spend any.

ALTER TABLE ai_cost_usage ADD COLUMN IF NOT EXISTS compute_cents real NOT NULL DEFAULT 0;
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS total_compute_cents real NOT NULL DEFAULT 0;

-- Daily per-org compute ceiling. 500 cents ($5/day) is the conservative
-- default the spec's §5.6 reservation path checks against; an org may raise it
-- through the existing budget settings surface.
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS max_compute_cents_per_day integer NOT NULL DEFAULT 500;

ALTER TABLE ai_budgets DROP CONSTRAINT IF EXISTS ai_budgets_max_compute_cents_chk;
ALTER TABLE ai_budgets ADD CONSTRAINT ai_budgets_max_compute_cents_chk
  CHECK (max_compute_cents_per_day >= 0);
