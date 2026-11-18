-- #9758 (MCP B-W04 follow-up): record the requester's auth_epoch on an
-- OAuth-originated MCP Tier-3 intent, so release can refuse exactly when it has
-- moved since filing (password change/reset, status change, membership removal,
-- global logout…) instead of relying on the best-effort post-commit OAuth grant
-- sweep (services/authLifecycle.ts runPostCommitCleanup).
--
-- Written once at INSERT by createActionIntent (services/actionIntents/
-- intentService.ts) from the epoch the bearer middleware admitted the filing
-- call at; compared against users.auth_epoch in loadLiveOAuthGrant
-- (services/mcpPrincipalAuth.ts). NULL for every other origin. No backfill:
-- an OAuth intent filed before this migration carries NULL and its release
-- fails closed (mcp_origin_revoked).
--
-- Idempotent; no row writes, so no system-scope elevation is needed.

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS origin_auth_epoch integer;

-- Only an MCP-origin OAuth intent may carry an epoch. Every existing row is
-- NULL here, so the constraint validates immediately.
ALTER TABLE action_intents
  DROP CONSTRAINT IF EXISTS action_intents_origin_auth_epoch_chk;
ALTER TABLE action_intents
  ADD CONSTRAINT action_intents_origin_auth_epoch_chk
  CHECK (
    origin_auth_epoch IS NULL
    OR (source = 'mcp_api' AND origin_principal_kind = 'oauth_grant')
  );

-- Immutable content: a release that could rewrite the recorded epoch could
-- satisfy its own check. Redefinition of the deny-list from
-- 2027-01-07-140000-flow-webhooks-tools-budgets.sql plus origin_auth_epoch.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.requesting_flow_run_id IS DISTINCT FROM OLD.requesting_flow_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.origin_auth_epoch IS DISTINCT FROM OLD.origin_auth_epoch
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
     OR NEW.invoked_flow_id IS DISTINCT FROM OLD.invoked_flow_id
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
