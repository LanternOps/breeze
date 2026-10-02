-- AI model registry W06 (#7604): audit rows for the loopback model gateway.
--
-- * connection_id: the partner_ai_connections row a gateway request was made
--   for. Provenance only — deliberately NO foreign key (a deleted connection must
--   not erase or block its audit trail; same posture as ai_invocations.connection_id).
-- * surface 'gateway_forward': one row per request the gateway forwards (or
--   refuses) to a gateway-kind connection's upstream.
--
-- W05 (#7603) re-issues this CHECK in 2026-11-29-100000-llm-egress-events-w05-surfaces.sql with
-- 'one_shot_token_count' and 'one_shot_continuation_summary'. This re-issue
-- unions those surfaces with the newest existing re-issue and gateway_forward,
-- so whichever wave merges first, neither drops the other's surfaces.
--
-- The CHECK preserves every surface from the newest existing re-issue
-- (2026-10-16-120000-llm-egress-events-script-review-surface.sql), plus W05's
-- additions and 'gateway_forward'. The TypeScript union includes gateway_forward;
-- W05 adds its own TypeScript surfaces separately.
--
-- No DML in this file, so the breeze.scope=system election rule does not apply.
-- Idempotent: ADD COLUMN IF NOT EXISTS; constraint dropped and re-added.
-- Export policy: connection_id is a plain identifier (included) — see
-- tenantExportPolicyRegistry.ts. Same table, same shape-1 RLS: no policy change.

ALTER TABLE public.llm_egress_events ADD COLUMN IF NOT EXISTS connection_id uuid;

DO $$
BEGIN
  ALTER TABLE public.llm_egress_events DROP CONSTRAINT IF EXISTS llm_egress_events_surface_chk;
  ALTER TABLE public.llm_egress_events ADD CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment', 'script_review_verdict',
    'one_shot_token_count', 'one_shot_continuation_summary',
    'gateway_forward'
  ));
END $$;

CREATE INDEX IF NOT EXISTS llm_egress_events_connection_idx
  ON public.llm_egress_events (connection_id, created_at)
  WHERE connection_id IS NOT NULL;
