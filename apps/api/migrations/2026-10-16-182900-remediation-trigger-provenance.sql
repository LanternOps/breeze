-- Fix-by-trigger provenance (#5744) — spec
-- docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md §5.
--
-- One shared three-column envelope stamped AT CREATION on the three execution
-- rows reports group by. text + CHECK, never pgEnum, matching action_intents'
-- deliberate convention (schema/actionIntents.ts:40-48).
--
-- NO DML. Historical rows keep NULL, which reads as "unknown trigger" (spec §7).
-- trigger_ref_id carries no FK: the referenced occurrence may be pruned or live
-- in a table the writer cannot import; a stale id matches nothing.

-- 1. action_intents ----------------------------------------------------------
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS trigger_kind   text;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS trigger_ref_id uuid;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS trigger_key    varchar(200);

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_trigger_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_trigger_kind_chk
  CHECK (trigger_kind IS NULL OR trigger_kind IN (
    'manual','schedule','sweep_finding','alert','monitor',
    'fleet_finding','policy','automation','ticket','anomaly','api'));

-- A ref id or a key without a kind is an unreadable half-record.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_trigger_shape_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_trigger_shape_chk
  CHECK (trigger_kind IS NOT NULL OR (trigger_ref_id IS NULL AND trigger_key IS NULL));

-- W05's sweep-lane graduation counter filters on this; partial because the
-- overwhelming majority of historical rows are NULL.
CREATE INDEX IF NOT EXISTS action_intents_trigger_kind_idx
  ON action_intents (trigger_kind) WHERE trigger_kind IS NOT NULL;

-- 2. script_executions -------------------------------------------------------
-- NOTE: this table ALSO has the shipped `trigger_type` pgEnum
-- (manual|scheduled|alert|policy|automation). The two are different things and
-- may legitimately disagree — trigger_type is the execution LANE, trigger_kind
-- is the CAUSE. See schema/scripts.ts for the paired docstrings.
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS trigger_kind   text;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS trigger_ref_id uuid;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS trigger_key    varchar(200);

ALTER TABLE script_executions DROP CONSTRAINT IF EXISTS script_executions_trigger_kind_chk;
ALTER TABLE script_executions ADD CONSTRAINT script_executions_trigger_kind_chk
  CHECK (trigger_kind IS NULL OR trigger_kind IN (
    'manual','schedule','sweep_finding','alert','monitor',
    'fleet_finding','policy','automation','ticket','anomaly','api'));

ALTER TABLE script_executions DROP CONSTRAINT IF EXISTS script_executions_trigger_shape_chk;
ALTER TABLE script_executions ADD CONSTRAINT script_executions_trigger_shape_chk
  CHECK (trigger_kind IS NOT NULL OR (trigger_ref_id IS NULL AND trigger_key IS NULL));

-- 3. automation_action_results ----------------------------------------------
-- The PER-ACTION, org-pinned row. Deliberately NOT automation_run_device_results
-- (an aggregate) and NOT automation_runs (which has no org_id at all and is
-- correctly absent from the export registry).
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS trigger_kind   text;
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS trigger_ref_id uuid;
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS trigger_key    varchar(200);

ALTER TABLE automation_action_results DROP CONSTRAINT IF EXISTS automation_action_results_trigger_kind_chk;
ALTER TABLE automation_action_results ADD CONSTRAINT automation_action_results_trigger_kind_chk
  CHECK (trigger_kind IS NULL OR trigger_kind IN (
    'manual','schedule','sweep_finding','alert','monitor',
    'fleet_finding','policy','automation','ticket','anomaly','api'));

ALTER TABLE automation_action_results DROP CONSTRAINT IF EXISTS automation_action_results_trigger_shape_chk;
ALTER TABLE automation_action_results ADD CONSTRAINT automation_action_results_trigger_shape_chk
  CHECK (trigger_kind IS NOT NULL OR (trigger_ref_id IS NULL AND trigger_key IS NULL));

-- Creation-time provenance is immutable. Preserve every existing guard.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.task_step_key IS DISTINCT FROM OLD.task_step_key
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.script_reviewer_evidence IS DISTINCT FROM OLD.script_reviewer_evidence
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.trigger_ref_id IS DISTINCT FROM OLD.trigger_ref_id
     OR NEW.trigger_key IS DISTINCT FROM OLD.trigger_key
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
