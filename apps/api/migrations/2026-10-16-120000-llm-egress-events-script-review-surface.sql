-- W02 (#5612): the script-proposal reviewer is a new one-shot LLM egress
-- surface. Mirrors the TypeScript LLM_EGRESS_SURFACES union
-- (apps/api/src/db/schema/llmEgressEvents.ts) — the two must be edited
-- together, same rule the original migration documents
-- (2026-09-13-c-llm-egress-events.sql); the live-DB parity test
-- (llmEgressEvents.integration.test.ts) enforces the pair. No DML in this
-- file, so the breeze.scope=system DML-fence rule does not apply.

DO $$
BEGIN
  ALTER TABLE llm_egress_events DROP CONSTRAINT IF EXISTS llm_egress_events_surface_chk;
  ALTER TABLE llm_egress_events ADD CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment', 'script_review_verdict'
  ));
END $$;
