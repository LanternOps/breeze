-- Wisp W05 (#10428, feature #11489): standing-instruction capture.
--
-- 1. The turn-end extractor is a sessionless Messages-API call with its own
--    egress surface, 'one_shot_wisp_instruction_extract'. Re-issue the CHECK
--    with the full list from 2027-01-22-190100-wisp-threads-picture.sql plus
--    the new surface (mirrors LLM_EGRESS_SURFACES in
--    src/db/schema/llmEgressEvents.ts; the two are edited together).
--
-- 2. A partial expression index on the device a standing instruction targets.
--    Capture writes one block per resolved device with content.deviceId set
--    by server-side name resolution; the standing-instruction enforcement
--    matcher (feature #11489, a later wave) looks up every live standing
--    instruction for a set of target devices through this index, complete for
--    those devices (not the recall path with its row limits).
--
-- No new table, no new column: RLS on both tables is unchanged.
-- ai_memory_blocks is deliberately not in the tenant-export or org-merge
-- registries (no org_id column; see 2027-01-04-110100-ai-memory-blocks.sql),
-- so no export classification is needed.
-- No row writes, so no system-scope election. Idempotent; no inner BEGIN/COMMIT.

DO $$
BEGIN
  ALTER TABLE public.llm_egress_events DROP CONSTRAINT IF EXISTS llm_egress_events_surface_chk;
  ALTER TABLE public.llm_egress_events ADD CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment', 'script_review_verdict',
    'one_shot_token_count', 'one_shot_continuation_summary',
    'gateway_forward',
    'flow_ai_step',
    'one_shot_wisp_thread_summary',
    'one_shot_wisp_instruction_extract'
  ));
END $$;

CREATE INDEX IF NOT EXISTS ai_memory_blocks_standing_device_idx
  ON public.ai_memory_blocks (tenant_partner_id, (content->>'deviceId'))
  WHERE block_type = 'standing_instruction';
