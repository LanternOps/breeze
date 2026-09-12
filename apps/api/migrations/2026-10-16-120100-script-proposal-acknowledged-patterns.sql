-- W03 human loop (#5612 / #5616): the STRICT security-pattern descriptions the
-- APPROVER acknowledged when they decided this proposal's intent.
--
-- Why here and not on action_intents / approval_requests: action_intents.arguments
-- is immutable (action_intents_immutable_trg) and approval_requests has no
-- free-form decision payload — intentReleaseWorker reads only
-- (id, status, bound_argument_digest) off the winning row. scriptDispatch already
-- holds the proposal row for a proposal-backed run, so this is the only place the
-- set can live without new plumbing through release.
--
-- Resolved server-side as (submitted ∩ strict_hits), exactly like the library's
-- resolveScriptSecurityAcknowledgement, so an approver cannot pre-acknowledge
-- the whole vocabulary. Writes no rows: no breeze.scope elevation needed.
ALTER TABLE script_proposals
  ADD COLUMN IF NOT EXISTS acknowledged_patterns text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN script_proposals.acknowledged_patterns IS
  'STRICT pattern descriptions acknowledged by the deciding approver; (submitted ∩ strict_hits).';
