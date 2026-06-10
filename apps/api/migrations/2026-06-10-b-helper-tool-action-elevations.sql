-- 2026-06-10-b-helper-tool-action-elevations.sql
--
-- Phase 1 (Helper tool-action governance, spec 2026-06-10):
--   * elevation_requests gains the ai_tool_action shape: execution_id links
--     the PAM decision back to ai_tool_executions (the gate waitForApproval
--     polls), plus tool_name / action_digest / risk_tier.
--   * pam_rules gains tool-action match criteria (match_tool_name,
--     match_risk_tier) so org/site policy can auto_approve / auto_deny /
--     require_approval specific Helper tools.
-- No RLS changes: both tables are already Shape-1 org-scoped; new columns
-- inherit the existing policies.

-- elevation_requests: ai_tool_action columns ------------------------------
ALTER TABLE elevation_requests
  ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES ai_tool_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tool_name varchar(100),
  ADD COLUMN IF NOT EXISTS action_digest varchar(64),
  ADD COLUMN IF NOT EXISTS risk_tier smallint;

-- Mirror-lookup hot path: /respond resolves execution_id for ai_tool_action rows.
CREATE INDEX IF NOT EXISTS elevation_requests_execution_id_idx
  ON elevation_requests (execution_id)
  WHERE execution_id IS NOT NULL;

-- Re-create the flow-shape constraint with the third branch. Note:
-- execution_id is deliberately NOT required by the constraint — its FK is
-- ON DELETE SET NULL, so requiring it would make ai_tool_executions rows
-- undeletable underneath historical elevations.
ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_flow_shape_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_flow_shape_chk
  CHECK (
    (flow_type = 'tech_jit_admin' AND subject_user_id IS NOT NULL)
    OR
    (flow_type = 'uac_intercept' AND target_executable_path IS NOT NULL)
    OR
    (flow_type = 'ai_tool_action' AND tool_name IS NOT NULL)
  );

-- pam_rules: tool-action match criteria -----------------------------------
ALTER TABLE pam_rules
  ADD COLUMN IF NOT EXISTS match_tool_name varchar(100),
  ADD COLUMN IF NOT EXISTS match_risk_tier smallint;
