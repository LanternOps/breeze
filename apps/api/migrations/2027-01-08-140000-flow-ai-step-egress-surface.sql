-- Tool Catalog W05 (#5220), PR D: LLM egress surface for the flow `ai` step.
--
-- The `ai` built-in (services/flows/builtins/aiStep.ts) makes Messages-API
-- calls on the run org's resolved model. When that model is a partner
-- catalog endpoint, the guarded fetch records one llm_egress_events row per
-- attempt; until now the step passed no caller context, so those attempts
-- were not audited (PR B deviation 4; decision 2026-10-26 on #10284).
--
-- This file sorts after 2026-12-03-100000-ai-gateway-egress-events.sql, the
-- last re-issue of the surface CHECK, and supersedes it: its list is that
-- file's eleven surfaces plus 'flow_ai_step'. LLM_EGRESS_SURFACES
-- (src/db/schema/llmEgressEvents.ts) carries all of them; edit both together.
--
-- No DML in this file, so the breeze.scope=system election rule does not apply.
-- Idempotent: the constraint is dropped and re-added. Same table, same shape-1
-- RLS, no new column: no policy or export-policy change.

DO $$
BEGIN
  ALTER TABLE public.llm_egress_events DROP CONSTRAINT IF EXISTS llm_egress_events_surface_chk;
  ALTER TABLE public.llm_egress_events ADD CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment', 'script_review_verdict',
    'one_shot_token_count', 'one_shot_continuation_summary',
    'gateway_forward',
    'flow_ai_step'
  ));
END $$;
