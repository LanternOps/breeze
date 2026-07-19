-- 2026-07-18-c: link ai_tool_executions rows to the durable action_intents
-- row they were created for (spec
-- docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md,
-- whole-branch review CRITICAL-3).
--
-- The web chat's per-step approval card (POST
-- /ai/sessions/:id/approve/:executionId -> handleApproval in
-- services/aiAgent.ts) only ever flipped ai_tool_executions.status. For
-- Tier-3 tools that is no longer the source of truth once
-- services/actionIntents/intentService.ts's createActionIntent takes over —
-- the chat flow blocks on action_intents.status via waitForIntentDecision,
-- so a handleApproval call that only touches ai_tool_executions is a silent
-- no-op: it reports success but nothing unblocks. This column lets
-- handleApproval detect an intent-backed execution and refuse to report a
-- self-approval success for it (the intents flow is a four-eyes model — the
-- requester is usually NOT an eligible approver of their own intent).
--
-- Nullable: legacy Tier-2 per_step executions (and helper/PAM executions)
-- never go through createActionIntent and keep intent_id NULL — handleApproval
-- keeps flipping ai_tool_executions.status directly for those, unchanged.
--
-- ON DELETE SET NULL (not CASCADE): the execution ledger row documents what
-- the chat session did; it must survive an intent row being purged/erased
-- independently rather than being silently deleted out from under the chat
-- transcript. Idempotent (ADD COLUMN IF NOT EXISTS). No inner
-- BEGIN/COMMIT — autoMigrate wraps this file in one transaction.

ALTER TABLE ai_tool_executions
  ADD COLUMN IF NOT EXISTS intent_id UUID REFERENCES action_intents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_tool_executions_intent_id_idx
  ON ai_tool_executions (intent_id)
  WHERE intent_id IS NOT NULL;
