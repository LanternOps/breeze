-- #10390: two writers shared wisp_threads.summary and the last one won.
--
-- finalizeWispSessionSummary wrote the last paragraph of a session's newest
-- reply there on every close, and rollupPartnerPicture wrote the concern
-- picture there after every assessment. Each overwrote the other, and both
-- seed the next session and the next assessment prompt.
--
-- From here on:
--   * wisp_threads.summary  = what the last session concluded and left open.
--     summary_session_id names the session that wrote it, so a repeated close
--     or an older session's late close cannot overwrite it. Typed reference
--     with no FK, like last_session_id: a closed session may be erased first.
--   * wisp_threads.picture  = the deterministic concern rollup, its own column.
--
-- Data: rows holding a picture move it to the new column. Every other non-empty
-- summary is a last paragraph ("Ask me to check back in 5-10 minutes…"), which
-- is what misled the sessions it seeded, so it is cleared; the text it came from
-- is still in ai_messages. Only rows no session has claimed are touched, so a
-- re-run after new summaries exist changes nothing.
--
-- Tenancy: wisp_threads is shape 3 (partner axis, breeze_has_partner_access) and
-- has no org_id. The table is in none of the org-cascade, org-merge or
-- tenant-export registries, so these columns need no classification, and the
-- existing FOR ALL policy covers them.
--
-- llm_egress_events: adds 'one_shot_wisp_thread_summary', the audited surface of
-- the model call that writes the summary. This list is the twelve surfaces of
-- 2027-01-08-140000-flow-ai-step-egress-surface.sql plus that one.
-- LLM_EGRESS_SURFACES (src/db/schema/llmEgressEvents.ts) carries all of them;
-- edit both together.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.wisp_threads ADD COLUMN IF NOT EXISTS summary_session_id uuid;
ALTER TABLE public.wisp_threads ADD COLUMN IF NOT EXISTS picture text NOT NULL DEFAULT '';
ALTER TABLE public.wisp_threads ADD COLUMN IF NOT EXISTS picture_updated_at timestamptz;

DO $$
BEGIN
  ALTER TABLE public.wisp_threads DROP CONSTRAINT IF EXISTS wisp_threads_picture_len_chk;
  ALTER TABLE public.wisp_threads ADD CONSTRAINT wisp_threads_picture_len_chk CHECK (char_length(picture) <= 4000);
END $$;

UPDATE public.wisp_threads
   SET picture = summary,
       picture_updated_at = summary_updated_at
 WHERE summary_session_id IS NULL
   AND picture = ''
   AND summary LIKE 'Wisp picture · %';

UPDATE public.wisp_threads
   SET summary = '',
       summary_updated_at = NULL
 WHERE summary_session_id IS NULL
   AND summary <> '';

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
    'one_shot_wisp_thread_summary'
  ));
END $$;
