-- External (tenant tool-source) binding for Tier-3 intents — tool catalog
-- W01 PR B (#5216), spec docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
-- §6.5 / §8.
--
-- A chat session that calls a Tier-3 BYO-MCP tool mints an action intent
-- bound to the exact `tool_source_tools` row and `revision` the approver saw.
-- Release-time revalidation (services/actionIntents/revalidateRelease.ts)
-- reloads the live row and fails closed on drift (`external_tool_drift`),
-- disable/removal (`external_tool_disabled`) and an inactive source
-- (`external_tool_source_unavailable`).
--
-- tool_source_tool_id carries NO foreign key, on purpose. The intent row is
-- immutable evidence (action_intents_block_content_update() below) and must
-- never be blocked — or silently tombstoned by ON DELETE SET NULL, which
-- would both fire the immutability trigger and violate the pairing CHECK —
-- when the tool row is deleted (source delete cascades its tools; org
-- erasure). Same convention as ai_origin_session_id / trigger_ref_id: a
-- stale id matches nothing and revalidation treats "no live row" as
-- `external_tool_disabled`. The binding is a pair: both set or both NULL.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- pg_constraint guard, CREATE OR REPLACE FUNCTION). No inner BEGIN/COMMIT.
-- Writes no rows. Sorts after 2026-10-16-193500-tool-sources.sql (PR A).

ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS tool_source_tool_id uuid;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS tool_revision text;

CREATE INDEX IF NOT EXISTS action_intents_tool_source_tool_id_idx
  ON action_intents (tool_source_tool_id) WHERE tool_source_tool_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'action_intents_external_tool_chk'
      AND conrelid = 'action_intents'::regclass
  ) THEN
    ALTER TABLE action_intents ADD CONSTRAINT action_intents_external_tool_chk
      CHECK ((tool_source_tool_id IS NULL) = (tool_revision IS NULL));
  END IF;
END $$;

-- The binding is creation-time content: a release that could re-point an
-- approved intent at a different tool or revision would defeat the drift
-- check. The definition below is 2026-10-16-182900's verbatim, plus two
-- lines. The RAISE text is byte-identical on purpose:
-- src/testUtils/actionIntentsTriggerDenyList.ts anchors its parser on it.
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
     OR NEW.tool_source_tool_id IS DISTINCT FROM OLD.tool_source_tool_id
     OR NEW.tool_revision IS DISTINCT FROM OLD.tool_revision
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
