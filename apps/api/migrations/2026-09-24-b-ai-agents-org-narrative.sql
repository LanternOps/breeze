-- Phase 2 wave P2-3 (#4187 / #4190): weekly org narrative.
--   1. ai_agent_schedules.kind + composite self-FK so an org override can
--      never disagree with its baseline's kind.
--   2. ai_agent_runs.report_run_id — the narrative artifact a run produced.
--   3. ai_agent_runs profile CHECK admits 'narrative'.
--   4. reports.source_ai_agent_schedule_id — typed identity of the schedule
--      that owns a system-managed report definition.
--   5. reports/report_runs.execution_scope_principal_kind — a system-run
--      report has no acting user.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. ai_agent_schedules.kind ---------------------------------------------------
-- A narrative schedule is its own row; org rows inherit the baseline's kind
-- through the composite self-FK below.
ALTER TABLE ai_agent_schedules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sweep';
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_chk CHECK (kind IN ('sweep', 'narrative'));

-- Sweep org overrides may legitimately hold '{}' (= disabled, P2-2), so the
-- empty-kinds rule is per arm, not an XOR: a narrative row NEVER carries sweep
-- kinds, and a partner SWEEP baseline must carry at least one.
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_kinds_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_kinds_chk CHECK (
  (kind = 'narrative' AND cardinality(sweep_kinds) = 0)
  OR (kind = 'sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds) > 0))
);

-- Composite-FK target. (id) is already the PK, so this index is redundant for
-- lookups; it exists solely because a FOREIGN KEY needs a UNIQUE constraint or
-- index over exactly its referenced column list.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_schedules_id_kind_uniq ON ai_agent_schedules (id, kind);

-- MATCH SIMPLE (the default): partner rows have baseline_schedule_id NULL and
-- are therefore unchecked, exactly as intended. Org overrides carry both legs,
-- so an override whose kind disagrees with its baseline's is 23503. ON DELETE
-- matches the existing single-column baseline_schedule_id FK from
-- 2026-09-23-ai-agents-scheduled-sweeps.sql (verified: CASCADE) — the two FKs
-- coexist and must not disagree on the delete action.
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_baseline_kind_fk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_baseline_kind_fk
  FOREIGN KEY (baseline_schedule_id, kind) REFERENCES ai_agent_schedules (id, kind) ON DELETE CASCADE;

-- 2. ai_agent_runs.report_run_id -----------------------------------------------
-- The narrative ARTIFACT this run produced (report_runs), not the definition:
-- the run trace links to something downloadable. ON DELETE SET NULL — run
-- history survives artifact deletion, same treatment as schedule_id/alert_id.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS report_run_id uuid NULL
  REFERENCES report_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_report_run_idx ON ai_agent_runs (report_run_id) WHERE report_run_id IS NOT NULL;

-- 3. profile CHECK admits 'narrative' ------------------------------------------
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative'));

-- 4. reports.source_ai_agent_schedule_id ---------------------------------------
-- Typed identity of the schedule that owns a system-managed report definition
-- (never a config-jsonb key). The partial unique index is what makes the
-- narrative worker's find-or-create idempotent under concurrency.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS source_ai_agent_schedule_id uuid NULL
  REFERENCES ai_agent_schedules(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_source_ai_agent_schedule_uniq
  ON reports (org_id, source_ai_agent_schedule_id) WHERE source_ai_agent_schedule_id IS NOT NULL;

-- 5. System report principal ---------------------------------------------------
-- NULL = legacy/user rows (unchanged semantics); 'system' = produced by a
-- scheduled agent run with no acting user.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS execution_scope_principal_kind text NULL;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS execution_scope_principal_kind text NULL;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_principal_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_principal_chk CHECK (
  execution_scope_principal_kind IS NULL OR execution_scope_principal_kind IN ('user', 'system')
);
ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_principal_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_principal_chk CHECK (
  execution_scope_principal_kind IS NULL OR execution_scope_principal_kind IN ('user', 'system')
);

-- Re-define the shape CHECKs from 2026-08-06-a-report-site-scope.sql (never
-- edit that file). The bodies below are that migration's bodies verbatim —
-- including the outer `... IS TRUE)` wrapper and the `legacy_unscoped` arm's
-- deliberate silence on execution_scope_user_id (it admits NULL or NOT NULL,
-- because the backfill copied reports.created_by, which is itself nullable) —
-- plus exactly three added principal_kind clauses:
--   * the all-NULL arm also requires principal_kind IS NULL;
--   * 'unrestricted' admits user_id NULL iff principal_kind = 'system';
--   * 'restricted' and 'legacy_unscoped' are never 'system' (a system run is
--     unrestricted by construction — it has no user whose site grants could
--     restrict it).
-- The two tables' bodies must stay in lockstep.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
  (
    execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL
    AND execution_scope_principal_kind IS NULL
  )
  OR
  (
    execution_scope_version = 1
    AND execution_scope_fingerprint IS NOT NULL
    AND execution_scope_captured_at IS NOT NULL
    AND (
      (
        execution_scope_kind = 'restricted'
        AND execution_scope_site_ids IS NOT NULL
        AND execution_scope_user_id IS NOT NULL
        AND execution_scope_principal_kind IS DISTINCT FROM 'system'
      )
      OR
      (
        execution_scope_kind = 'unrestricted'
        AND execution_scope_site_ids IS NULL
        AND (
          (execution_scope_principal_kind = 'system' AND execution_scope_user_id IS NULL)
          OR (execution_scope_principal_kind IS DISTINCT FROM 'system' AND execution_scope_user_id IS NOT NULL)
        )
      )
      OR
      (
        execution_scope_kind = 'legacy_unscoped'
        AND execution_scope_site_ids IS NULL
        AND execution_scope_principal_kind IS DISTINCT FROM 'system'
      )
    )
  )
) IS TRUE);

ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK ((
  (
    execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL
    AND execution_scope_principal_kind IS NULL
  )
  OR
  (
    execution_scope_version = 1
    AND execution_scope_fingerprint IS NOT NULL
    AND execution_scope_captured_at IS NOT NULL
    AND (
      (
        execution_scope_kind = 'restricted'
        AND execution_scope_site_ids IS NOT NULL
        AND execution_scope_user_id IS NOT NULL
        AND execution_scope_principal_kind IS DISTINCT FROM 'system'
      )
      OR
      (
        execution_scope_kind = 'unrestricted'
        AND execution_scope_site_ids IS NULL
        AND (
          (execution_scope_principal_kind = 'system' AND execution_scope_user_id IS NULL)
          OR (execution_scope_principal_kind IS DISTINCT FROM 'system' AND execution_scope_user_id IS NOT NULL)
        )
      )
      OR
      (
        execution_scope_kind = 'legacy_unscoped'
        AND execution_scope_site_ids IS NULL
        AND execution_scope_principal_kind IS DISTINCT FROM 'system'
      )
    )
  )
) IS TRUE);
