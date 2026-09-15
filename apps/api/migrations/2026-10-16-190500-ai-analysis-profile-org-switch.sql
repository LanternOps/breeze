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
