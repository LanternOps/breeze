-- Wisp analysis sessions W03 (feature #11844, sub-issue #11847) — analysis
-- run lineage, and the dataset an export_dataset artifact holds.
--
-- An analysis run can continue an earlier analysis run: it inherits the
-- chain's exported and collected files and a fenced seed of the prior result.
-- The chain is bounded in depth, run count and reserved spend at admission
-- (runService step 4d), so the lineage has to be readable in SQL under the
-- admission lock and by retention. That is why it is three real columns, not
-- keys in trigger_ref (an open jsonb container the export policy excludes):
--
--   continued_from_run_id  the analysis run this one continues (NULL for a
--                          chain root, or after that run was deleted)
--   chain_root_run_id      the first run of the chain (NULL for a root, or
--                          after the root was deleted)
--   chain_depth            0 = a chain root (every existing row), N = the
--                          Nth continuation
--
-- ai_run_artifacts.dataset is the export_dataset dataset name, NULL for every
-- other artifact (and for exports written before this wave). A continuation
-- re-checks it against the launch's frozen export grants.
--
-- The CHECK is one-directional: depth 0 never carries lineage. The converse
-- (depth > 0 ⇒ both pointers set) is stamped by admission and is NOT a CHECK:
-- both FKs are ON DELETE SET NULL (<pointer>), so deleting an ancestor clears
-- each pointer independently and a two-way CHECK would make that delete fail
-- (same lesson as ai_agent_runs_depth_chk in
-- 2027-01-05-100400-wisp-specialist-lineage.sql).
--
-- DDL only — the file writes no rows, so no breeze.scope election is needed.
-- Idempotent: ADD COLUMN IF NOT EXISTS, drop-then-add constraints,
-- CREATE INDEX IF NOT EXISTS.

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS continued_from_run_id uuid;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS chain_root_run_id uuid;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS chain_depth smallint NOT NULL DEFAULT 0;

ALTER TABLE ai_run_artifacts ADD COLUMN IF NOT EXISTS dataset text;

-- Same-org self-FKs over (pointer, org_id), so a run can never name another
-- tenant's run. DEFERRABLE INITIALLY IMMEDIATE because org merge defers
-- constraints while it rewrites org_id. `SET NULL (<pointer>)` — the PG15+
-- column-list form — so deleting the ancestor (retention, erasure) clears only
-- the pointer and org_id survives.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_continued_from_run_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_continued_from_run_fk
  FOREIGN KEY (continued_from_run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE SET NULL (continued_from_run_id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_chain_root_run_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_chain_root_run_fk
  FOREIGN KEY (chain_root_run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE SET NULL (chain_root_run_id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_chain_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_chain_chk
  CHECK (chain_depth >= 0 AND (chain_depth > 0 OR (continued_from_run_id IS NULL AND chain_root_run_id IS NULL)));

-- The chain-bound sum and retention's chain guard look members up by root;
-- the continued-from index exists so the FK's SET NULL on delete does not
-- scan the table.
CREATE INDEX IF NOT EXISTS ai_agent_runs_chain_root_idx
  ON ai_agent_runs (org_id, chain_root_run_id) WHERE chain_root_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_continued_from_idx
  ON ai_agent_runs (continued_from_run_id) WHERE continued_from_run_id IS NOT NULL;

COMMENT ON COLUMN ai_agent_runs.continued_from_run_id IS 'Wisp analysis sessions W03: the analysis run this run continues (NULL for a chain root, or after that run was deleted).';
COMMENT ON COLUMN ai_agent_runs.chain_root_run_id IS 'Wisp analysis sessions W03: the first run of this analysis chain (NULL for a root, or after the root was deleted).';
COMMENT ON COLUMN ai_agent_runs.chain_depth IS 'Wisp analysis sessions W03: 0 = a chain root; N = the Nth continuation. Bounded by analysisMaxChainDepth at admission.';
COMMENT ON COLUMN ai_run_artifacts.dataset IS 'Wisp analysis sessions W03: the export_dataset dataset this artifact holds; NULL for every other artifact.';
