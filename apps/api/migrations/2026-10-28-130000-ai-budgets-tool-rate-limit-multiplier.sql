-- Per-tool AI/MCP rate-limit multiplier (#6476).
--
-- Raises every entry of TOOL_RATE_LIMITS (services/aiGuardrails.ts) by this
-- factor: effective limit = ceil(limit * multiplier). It can only RAISE a
-- limit — 1 is the shipped behaviour, and the CHECK below keeps a stored value
-- from ever lowering (0/negative) or effectively removing (huge) one.
--
-- NOT NULL DEFAULT 1, like the sibling ai_budgets columns
-- (max_turns_per_session, messages_per_minute_per_user, ...): 1 is exactly the
-- default the effective-settings merge would fill in, so a stored 1 and an
-- inherited 1 behave identically, and the partner JSONB aiBudgets key still
-- wins and locks (services/effectiveSettings.ts AI_BUDGET_FIELDS).
--
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is a metadata-only change on
-- PG11+; ai_budgets holds at most one row per org, so the CHECK validation
-- scan is trivial. No row writes.
ALTER TABLE ai_budgets
  ADD COLUMN IF NOT EXISTS tool_rate_limit_multiplier integer NOT NULL DEFAULT 1;

ALTER TABLE ai_budgets
  DROP CONSTRAINT IF EXISTS ai_budgets_tool_rate_limit_multiplier_chk;
ALTER TABLE ai_budgets
  ADD CONSTRAINT ai_budgets_tool_rate_limit_multiplier_chk
  CHECK (tool_rate_limit_multiplier BETWEEN 1 AND 10);
