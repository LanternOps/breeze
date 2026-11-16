-- MCP unattended proposal runs: an operator-set risk ceiling on the partner
-- AI script policy row, a claim column so an unattended run consumes its
-- proposal exactly once, and the approval_method value those runs record.
-- No row writes, so no breeze.scope election. No new table, so no RLS or
-- cascade change; both new columns are classified in CORE_TENANT_EXPORT_POLICY
-- (tenantExportPolicyRegistry.ts).

-- 'none' (the default) keeps today's behaviour: every proposal run over MCP
-- needs a human approval, even for a principal on
-- MCP_UNATTENDED_TIER3_PRINCIPALS. Only the PARTNER ceiling row carries a
-- value; an org grant row stays 'none'.
ALTER TABLE ai_script_policies
  ADD COLUMN IF NOT EXISTS mcp_unattended_proposal_max_risk TEXT NOT NULL DEFAULT 'none';
ALTER TABLE ai_script_policies
  DROP CONSTRAINT IF EXISTS ai_script_policies_mcp_unattended_proposal_max_risk_chk;
ALTER TABLE ai_script_policies
  ADD CONSTRAINT ai_script_policies_mcp_unattended_proposal_max_risk_chk
  CHECK (
    mcp_unattended_proposal_max_risk IN ('none', 'low', 'medium', 'high', 'critical')
    AND (org_id IS NULL OR mcp_unattended_proposal_max_risk = 'none')
  );

-- The MCP tool-execution ledger id of the unattended run that claimed this
-- proposal. A bare uuid like intent_id (the ledger row has its own
-- retention). A proposal is consumed when either column is set.
ALTER TABLE script_proposals
  ADD COLUMN IF NOT EXISTS mcp_unattended_claim_id UUID;

ALTER TABLE script_executions
  DROP CONSTRAINT IF EXISTS script_executions_approval_method_chk;
ALTER TABLE script_executions
  ADD CONSTRAINT script_executions_approval_method_chk
  CHECK (approval_method IS NULL OR approval_method IN
    ('supervised_self','four_eyes','unattended_reviewer_gated','direct_ui','automation',
     'unattended_mcp_principal'));
