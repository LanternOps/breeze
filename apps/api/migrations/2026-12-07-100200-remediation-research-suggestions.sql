-- AI Suggested Fixes W2: what research suggestions need on the existing
-- remediation_suggestions table, plus the built-in action refs the outcome
-- watcher follows on fix_outcomes (W1). Existing rows are untouched (all new
-- columns nullable). Idempotent; DDL only; no inner BEGIN/COMMIT.

ALTER TABLE remediation_suggestions ADD COLUMN IF NOT EXISTS agent_run_id uuid REFERENCES ai_agent_runs(id) ON DELETE SET NULL;
ALTER TABLE remediation_suggestions ADD COLUMN IF NOT EXISTS builtin_action varchar(40);
ALTER TABLE remediation_suggestions ADD COLUMN IF NOT EXISTS research_ordinal smallint;
ALTER TABLE remediation_suggestions ADD COLUMN IF NOT EXISTS instructions_id uuid REFERENCES fix_instructions(id) ON DELETE SET NULL;

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_target_type_check;
ALTER TABLE remediation_suggestions ADD CONSTRAINT remediation_suggestions_target_type_check
  CHECK (target_type IN ('script', 'script_template', 'playbook', 'diagnostic', 'manual_steps', 'builtin_action', 'script_draft'));

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_builtin_action_check;
ALTER TABLE remediation_suggestions ADD CONSTRAINT remediation_suggestions_builtin_action_check
  CHECK (builtin_action IN ('reboot', 'restart_service', 'kill_process', 'disk_cleanup'));

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_target_check;
ALTER TABLE remediation_suggestions ADD CONSTRAINT remediation_suggestions_target_check CHECK (
  (target_type = 'script' AND script_id IS NOT NULL)
  OR (target_type = 'script_template' AND script_template_id IS NOT NULL)
  OR (target_type = 'playbook' AND playbook_id IS NOT NULL)
  OR (target_type = 'diagnostic')
  OR (target_type = 'manual_steps')
  OR (target_type = 'builtin_action' AND builtin_action IS NOT NULL)
  OR (target_type = 'script_draft')
);

-- A built-in action has no tool/script/playbook execution row; its command or
-- cleanup-run id lives on the fix_outcomes attempt (below). NOT VALID like the
-- original (2026-06-18-zzz), so existing rows are not re-checked.
ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_terminal_execution_link_check;
ALTER TABLE remediation_suggestions ADD CONSTRAINT remediation_suggestions_terminal_execution_link_check CHECK (
  status NOT IN ('executed', 'failed')
  OR tool_execution_id IS NOT NULL OR script_execution_id IS NOT NULL OR playbook_execution_id IS NOT NULL
  OR target_type = 'builtin_action'
) NOT VALID;

-- One row per accepted research item; the finalizer's idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS remediation_suggestions_research_item_uq
  ON remediation_suggestions (agent_run_id, research_ordinal) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS remediation_suggestions_agent_run_idx
  ON remediation_suggestions (agent_run_id) WHERE agent_run_id IS NOT NULL;

-- Memory-attached (non-research) built-in and reviewed-steps rows: one per
-- source + action / + reviewed instructions, the same "one attempt per source +
-- fix" rule W1 adopted for scripts (spec amendment). Keyed on origin, NOT
-- agent_run_id: agent_run_id is ON DELETE SET NULL, so a predicate on it would
-- pull research rows into the index when their run is deleted (23505 on
-- erasure). origin never changes. DROP then CREATE so the index definition is
-- authoritative on re-apply.
DROP INDEX IF EXISTS remediation_suggestions_source_builtin_uq;
CREATE UNIQUE INDEX remediation_suggestions_source_builtin_uq
  ON remediation_suggestions (org_id, source_type, source_id, builtin_action)
  WHERE target_type = 'builtin_action' AND origin <> 'ai_research';
DROP INDEX IF EXISTS remediation_suggestions_source_instructions_uq;
CREATE UNIQUE INDEX remediation_suggestions_source_instructions_uq
  ON remediation_suggestions (org_id, source_type, source_id, instructions_id)
  WHERE target_type = 'manual_steps' AND instructions_id IS NOT NULL AND origin <> 'ai_research';

-- Built-in actions (W2): a synchronous command's id, or the async
-- OS-native cleanup run the watcher polls. device_commands is system-scoped
-- (no FK by design); the cleanup run is an org table, SET NULL on delete.
ALTER TABLE fix_outcomes ADD COLUMN IF NOT EXISTS action_command_id uuid;
ALTER TABLE fix_outcomes ADD COLUMN IF NOT EXISTS action_cleanup_run_id uuid
  REFERENCES device_filesystem_cleanup_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_cleanup_run_idx ON fix_outcomes (action_cleanup_run_id) WHERE action_cleanup_run_id IS NOT NULL;
