-- AI model registry W05 (#7603): two new one-shot LLM egress surfaces —
-- 'one_shot_token_count' (the transcript-fit count before a model switch)
-- and 'one_shot_continuation_summary'. Mirrors the TypeScript
-- LLM_EGRESS_SURFACES union (apps/api/src/db/schema/llmEgressEvents.ts);
-- llmEgressEvents.integration.test.ts enforces the pair. The new list is a
-- strict superset, so re-adding the CHECK validates every existing row.
-- DDL only: no row writes, so no system-scope election is needed.

DO $$
BEGIN
  ALTER TABLE llm_egress_events DROP CONSTRAINT IF EXISTS llm_egress_events_surface_chk;
  ALTER TABLE llm_egress_events ADD CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment', 'script_review_verdict',
    'one_shot_token_count', 'one_shot_continuation_summary'
  ));
END $$;
