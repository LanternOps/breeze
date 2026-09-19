-- AI patch agent W01 (#5747). Widens three CHECKs so a `patch` run profile and
-- a `patch` schedule kind are storable. DDL only — no rows written, so no
-- breeze.scope election (migrationRlsScope.test.ts). Idempotent (DROP ... IF
-- EXISTS then re-add); no inner BEGIN/COMMIT (autoMigrate wraps each file).
-- `ai_agents_kind_chk` already admits 'patch' (2026-10-16-170500). The
-- composite self-FK ai_agent_schedules_baseline_kind_fk (baseline_schedule_id,
-- kind) -> (id, kind) carries a new kind value through unmodified.

-- 1. ai_agent_runs.profile admits 'patch' -----------------------------------
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage', 'design', 'patch'));

-- 2. ai_agent_schedules.kind admits 'patch' ---------------------------------
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_chk
  CHECK (kind IN ('sweep', 'narrative', 'design', 'patch'));

-- 3. 'patch' joins the ZERO-CARDINALITY arm: a patch schedule evaluates no
-- sweep kinds, exactly like narrative and design. The sweep arm keeps its
-- `org_id IS NOT NULL` exemption (an org override's `[]` means "disable every
-- kind for this org").
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_kinds_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_kinds_chk CHECK (
  (kind IN ('narrative', 'design', 'patch') AND cardinality(sweep_kinds) = 0)
  OR (kind = 'sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds) > 0))
);
