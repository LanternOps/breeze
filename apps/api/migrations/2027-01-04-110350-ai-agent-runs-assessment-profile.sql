-- Wisp W05b (feature #9906): the `assessment` run profile. Widens
-- ai_agent_runs_profile_chk to match AI_AGENT_RUN_PROFILES
-- (packages/shared/src/types/aiAgents.ts), which gained 'assessment'.
--
-- A separate file from W05a's 2027-01-04-110300-wisp-concerns-watches.sql on
-- purpose: aiAgentSchedulesPartnerRls.integration.test.ts asserts the live
-- CHECK equals the enum, so the CHECK moves in the same change as the enum.
-- The live contract test is aiAgentsAssessmentProfile.migration.test.ts.
--
-- Idempotent (DROP CONSTRAINT IF EXISTS, then ADD); no inner BEGIN/COMMIT.
-- DDL only — it writes no rows, so it needs no breeze.scope system election.
-- Existing rows all carry one of the previous nine profiles, so the widened
-- CHECK validates immediately.

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design', 'patch', 'analysis', 'remediation_research', 'assessment'));
