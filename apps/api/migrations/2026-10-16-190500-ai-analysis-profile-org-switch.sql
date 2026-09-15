-- 2026-10-16: Execution plane W04 — analysis profile org switch + frozen inputs.
--
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md
--       §6.3 (existing tables), §8 (per-org external-processing switch).
--
-- DDL only: this file writes no rows, so it elects no `breeze.scope`
-- (apps/api/src/db/migrationRlsScope.test.ts). Both statements are
-- `ADD COLUMN IF NOT EXISTS`, so re-applying is a no-op.
--
-- `organizations.ai_external_processing`: the per-org opt-in for model-written
-- code executing on a vendor sandbox. Default FALSE until the Vercel DPA /
-- subprocessor review (spec §14.4). Checked at ADMISSION of every
-- `analysis`-profile run (runService.ts), never in the process-memoized tool
-- catalog. `organizations` is a Shape-2 (id-keyed) RLS table already
-- registered everywhere; a plain boolean column needs only the export-policy
-- classification (tenantExportPolicyRegistry.ts → `included`).

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_external_processing boolean NOT NULL DEFAULT false;

-- The frozen input allowlist of an analysis run: `{ handles: uuid[],
-- deviceIds: uuid[], region: 'eu'|'us' }`. `workspace_stage` accepts ONLY a
-- handle listed here or produced by this run (spec §5.3 table, §8 "Data
-- minimisation"); dataset tools are bounded to `deviceIds` through
-- `allowedDeviceIds` on the agent's AuthContext. jsonb → export-policy
-- `excludedOpen`. NULL for every non-analysis profile.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS staged_inputs jsonb;

-- `profile` admits 'analysis'. The CHECK is a second copy of
-- `AI_AGENT_RUN_PROFILES` (packages/shared): a profile added to the tuple and
-- not here ships as a 23514 on the first admitted run, which is exactly what
-- aiAgentsAnalysisProfile.migration.test.ts pins. Drop-then-add rather than a
-- NOT VALID add, because the constraint is tiny and the table's existing rows
-- all carry a previously-listed value.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design', 'patch', 'analysis'));
