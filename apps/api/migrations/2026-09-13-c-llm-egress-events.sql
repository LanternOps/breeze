-- Phase 2 of per-partner LLM BYOK (#3922): per-request egress audit.
--
-- One row per outbound LLM attempt — a guarded one-shot fetch or a CONNECT
-- through the SDK egress proxy — allowed or blocked. This is the record that
-- answers "which of my tenants' traffic went where, and when was something
-- refused"; it is deliberately per-request, not per-session, because a session
-- can dial many times and a rebinding attempt shows up as one refused dial in
-- the middle of an otherwise healthy session.
--
-- Dated 2026-09-13 (NOT 2026-09-12-b as the plan doc said): Task 1.1 shipped as
-- `2026-09-12-llm-provider-catalog.sql` with NO infix, and localeCompare puts
-- 'b' before 'l', so a same-date -b- file would have replayed BEFORE the
-- catalog tables this one has FKs into. Same class as #506. The same-day
-- infix rule only orders files that all carry an infix. The -c- letter simply
-- follows the -b- provenance migration committed just before this one; the two
-- are independent, and both land after the 2026-09-12 catalog file.

CREATE TABLE IF NOT EXISTS llm_egress_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  partner_id       uuid NOT NULL,
  catalog_entry_id uuid REFERENCES llm_provider_catalog(id) ON DELETE SET NULL,
  revision_id      uuid REFERENCES llm_provider_catalog_revisions(id) ON DELETE SET NULL,
  ai_session_id    uuid,
  surface          text NOT NULL,
  host             text NOT NULL,
  resolved_ip      text,
  blocked          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment'
  )),
  -- Dual-axis integrity, the `users` pattern: a row cannot name an org that
  -- belongs to a different partner than the one it bills.
  CONSTRAINT llm_egress_events_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS llm_egress_events_org_idx ON llm_egress_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_egress_events_partner_idx ON llm_egress_events(partner_id, created_at DESC);

-- RLS shape 1 (direct org_id column).
ALTER TABLE llm_egress_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_egress_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS llm_egress_events_isolation ON llm_egress_events;
CREATE POLICY llm_egress_events_isolation ON llm_egress_events
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_egress_events TO breeze_app;
