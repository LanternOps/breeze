-- Fleet Designer W01 (spec §4.1, §4.4). DDL only — no rows written, no
-- breeze.scope election. Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps).

-- 1. ai_agents.kind admits 'designer' ---------------------------------------
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_kind_chk;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_kind_chk
  CHECK (kind IN ('triage', 'patch', 'helpdesk', 'designer'));

-- 2. ai_agent_runs.profile admits 'design' ----------------------------------
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design'));

-- 3. ai_agent_schedules.kind admits 'design'; a design schedule sweeps nothing
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_chk
  CHECK (kind IN ('sweep', 'narrative', 'design'));
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_kinds_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_kinds_chk CHECK (
  (kind IN ('narrative', 'design') AND cardinality(sweep_kinds) = 0)
  OR (kind = 'sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds) > 0))
);

-- 4. One Fleet Design definition per organization ---------------------------
-- Manual design runs have no schedule, so the definition cannot be keyed on
-- source_ai_agent_schedule_id like the narrative's. Keyed on the type instead;
-- the org-merge reports executor dedupes on the same predicate (Task 4).
CREATE UNIQUE INDEX IF NOT EXISTS reports_ai_fleet_design_org_uniq
  ON reports (org_id) WHERE type = 'ai_fleet_design';
