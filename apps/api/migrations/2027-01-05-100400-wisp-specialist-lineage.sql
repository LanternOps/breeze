-- Wisp W07 (feature #9906, sub-issue #9913; w00 A11) — specialist lineage.
--
-- A specialist request is Wisp's assessment run (depth 0, profile
-- 'assessment', under a grant) handing bounded work to an existing agent. The
-- child — an ai_agent_runs row or an ai_operator_tasks row — records who asked
-- for it and under which grant revision, and carries depth 1. Admission refuses
-- a grant-bearing request whose requesting run is itself a child (the depth-one
-- rule, Wisp design §4.5); these columns are that guard's input and the
-- provenance the run/task detail pages show ("Wisp for <user>").
--
--   requested_by_run_id      the assessment run that requested the child
--   parent_grant_revision_id the grant revision the request was made under
--   depth                    0 = not a specialist child (every existing row),
--                            1 = a specialist child. Nothing deeper exists.
--
-- DDL only — the file writes no rows, so no breeze.scope election is needed.
-- Idempotent: ADD COLUMN IF NOT EXISTS + drop-then-add constraints.

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS requested_by_run_id uuid;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS parent_grant_revision_id uuid;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS depth smallint NOT NULL DEFAULT 0;

ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS requested_by_run_id uuid;
ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS parent_grant_revision_id uuid;
ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS depth smallint NOT NULL DEFAULT 0;

-- The requesting run is in the same org as the child (a grant never reaches
-- across orgs inside one request). Composite FK over (requested_by_run_id,
-- org_id) so a child can never name another tenant's run; DEFERRABLE INITIALLY
-- IMMEDIATE because org merge defers constraints while it rewrites org_id.
-- `SET NULL (requested_by_run_id)` — the PG15+ column-list form — so deleting
-- the parent (retention, erasure) clears only the pointer and org_id survives.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_requested_by_run_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_requested_by_run_fk
  FOREIGN KEY (requested_by_run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE SET NULL (requested_by_run_id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_requested_by_run_fk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_requested_by_run_fk
  FOREIGN KEY (requested_by_run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE SET NULL (requested_by_run_id) DEFERRABLE INITIALLY IMMEDIATE;

-- The revision is deleted only with its grant, by erasure; the pointer clears.
-- SQL-only (no Drizzle references()), like grant_revision_id: a Drizzle edge
-- into W02's schema module would be an import cycle.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_parent_grant_revision_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_parent_grant_revision_fk
  FOREIGN KEY (parent_grant_revision_id) REFERENCES wisp_grant_revisions (id) ON DELETE SET NULL;

ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_parent_grant_revision_fk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_parent_grant_revision_fk
  FOREIGN KEY (parent_grant_revision_id) REFERENCES wisp_grant_revisions (id) ON DELETE SET NULL;

-- depth is 0 or 1, and a depth-0 row never carries lineage. The converse
-- (depth 1 ⇒ lineage set) is stamped by admission at insert but is NOT a
-- CHECK: both pointers are ON DELETE SET NULL, so a child legitimately
-- outlives its parent run (retention) or the revision (erasure) — and a CHECK
-- requiring them would make those deletes fail.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_depth_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_depth_chk
  CHECK (depth IN (0, 1) AND (depth = 1 OR (requested_by_run_id IS NULL AND parent_grant_revision_id IS NULL)));

ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_depth_chk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_depth_chk
  CHECK (depth IN (0, 1) AND (depth = 1 OR (requested_by_run_id IS NULL AND parent_grant_revision_id IS NULL)));

-- The finalizer, the activity feed and the admin page look children up by
-- their requesting run; the FK's SET NULL action needs it too.
CREATE INDEX IF NOT EXISTS ai_agent_runs_requested_by_run_idx
  ON ai_agent_runs (requested_by_run_id) WHERE requested_by_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_operator_tasks_requested_by_run_idx
  ON ai_operator_tasks (requested_by_run_id) WHERE requested_by_run_id IS NOT NULL;

COMMENT ON COLUMN ai_agent_runs.requested_by_run_id IS 'Wisp W07: the assessment run that requested this specialist child (NULL for non-children, or after the parent was deleted).';
COMMENT ON COLUMN ai_agent_runs.parent_grant_revision_id IS 'Wisp W07: the wisp_grant_revisions row the specialist request was made under.';
COMMENT ON COLUMN ai_agent_runs.depth IS 'Wisp W07: 0 = not a specialist child; 1 = a specialist child. Depth is one (Wisp design §4.5).';
COMMENT ON COLUMN ai_operator_tasks.requested_by_run_id IS 'Wisp W07: the assessment run that requested this specialist task.';
COMMENT ON COLUMN ai_operator_tasks.parent_grant_revision_id IS 'Wisp W07: the wisp_grant_revisions row the specialist request was made under.';
COMMENT ON COLUMN ai_operator_tasks.depth IS 'Wisp W07: 0 = not a specialist child; 1 = a specialist child.';
