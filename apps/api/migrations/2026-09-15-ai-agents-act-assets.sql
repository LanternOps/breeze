-- Wave 4 Part B, Task 6 (#3826): per-script act-mode authorization.
--
-- `ai_agents.tool_allowlist` admitting `run_script` only says the agent may
-- CALL the tool; it says nothing about which saved scripts it may run
-- unattended, and a saved script can do anything its author wrote. This is
-- the separate, closed set an operator opts a script into — checked by
-- actRevalidation.ts's per-op asset pin before ANY unattended run_script
-- execution, never by resolveActOperation's shape-only match.
--
-- Not shoehorned into an existing column (Global Constraints, plan header):
-- protected_resources is protection, tool_allowlist is string[] tool names,
-- limits is numeric caps, recipients/triggers are what they say — none of
-- them is a semantically honest carrier for "scripts authorized to act".
--
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps the file).

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS act_assets jsonb NOT NULL DEFAULT '{}'::jsonb;
