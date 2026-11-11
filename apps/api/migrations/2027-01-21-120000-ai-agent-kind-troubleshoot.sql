-- Wisp delegation W1 (#11084, feature #11083): the `troubleshoot` agent kind
-- and the `device_troubleshooting` run profile. A device-troubleshooting
-- specialist launched from Wisp runs as a device-pinned background run, owned
-- by a system-provisioned partner-level `troubleshoot` agent and forced to
-- shadow at admission, so every change it wants becomes an approval intent.
--
-- Widens both CHECKs to match AI_AGENT_KINDS and AI_AGENT_RUN_PROFILES
-- (packages/shared/src/types/aiAgents.ts). Each list is the union of the last
-- committed definition plus the new value:
--   ai_agents_kind_chk         2026-12-07-100000-ai-agents-research-kind.sql
--   ai_agent_runs_profile_chk  2027-01-04-110350-ai-agent-runs-assessment-profile.sql
-- The live contract test is aiAgentsTroubleshootKind.migration.test.ts.
--
-- Idempotent (DROP CONSTRAINT IF EXISTS, then ADD); no inner BEGIN/COMMIT.
-- DDL only — it writes no rows, so it needs no breeze.scope system election.
-- Existing rows all carry a previously admitted value, so both widened CHECKs
-- validate immediately.

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_kind_chk;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_kind_chk
  CHECK (kind IN ('triage', 'patch', 'helpdesk', 'designer', 'research', 'troubleshoot'));

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design', 'patch', 'analysis', 'remediation_research', 'assessment', 'device_troubleshooting'));
