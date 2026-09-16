-- m365_signin_events (#5784 W05): interactive Microsoft 365 sign-ins, append-only.
--
-- Tenancy shape 1: direct org_id NOT NULL, RLS enabled + forced, one FOR ALL
-- breeze_has_org_access(org_id) policy created HERE, in the table's own
-- migration. Template: 2026-10-16-170200-m365-tenant-sync-foundation.sql:321-358.
--
-- Deliberate shape choices (spec §3.5.2):
--   * NO connection_id. The entity snapshot tables carry none either; connection
--     identity lives in m365_sync_state. Omitting it removes the composite-FK
--     direction question entirely. A later wave adding it MUST make it
--     ON DELETE CASCADE and DEFERRABLE INITIALLY IMMEDIATE — the org merge runs
--     SET CONSTRAINTS ALL DEFERRED and a non-deferrable composite org FK aborts
--     it with 23503.
--   * NO jsonb. The raw Graph payload stays out, so nothing lands in the
--     excludedOpen export bucket and sign-in PII is exactly the fields the
--     report renders.
--   * tenant_id is tenant PROVENANCE, following m365_secure_score_snapshots:
--     retained history outlives a disconnect/rebind (services/m365Sync/lifecycle.ts)
--     and must never be attributed to the tenant that replaced it.
--   * signed_in_at (Graph createdDateTime, the event time and the watermark) and
--     ingested_at are SEPARATE, so late-arriving events are detectable rather
--     than silently changing a closed period's totals.
--
-- DDL only: no rows are written, so no breeze.scope election is required.
-- Depends on 2026-10-17-094000-m365-sync-domain-signin-events.sql only for
-- ordering discipline; this file uses no new enum label.

CREATE TABLE IF NOT EXISTS m365_signin_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  graph_id TEXT NOT NULL,
  signed_in_at TIMESTAMPTZ NOT NULL,
  user_graph_id TEXT,
  user_principal_name TEXT,
  app_id TEXT,
  app_display_name TEXT,
  client_app_used TEXT,
  ip_address TEXT,
  location_city TEXT,
  location_country TEXT,
  conditional_access_status TEXT,
  status_error_code INTEGER,
  status_failure_reason TEXT,
  risk_level_aggregated TEXT,
  risk_state TEXT,
  is_interactive BOOLEAN,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (org_id, graph_id) is what makes re-sync idempotent: the overlapping delta
-- window deliberately re-fetches recent events, and every write is an upsert.
CREATE UNIQUE INDEX IF NOT EXISTS m365_signin_events_org_graph_uniq
  ON m365_signin_events (org_id, graph_id);

-- The report's only access pattern: one org, one period, newest first. Also the
-- index the delta watermark query (MAX(signed_in_at) per org) rides.
CREATE INDEX IF NOT EXISTS m365_signin_events_org_signed_in_idx
  ON m365_signin_events (org_id, signed_in_at DESC);

ALTER TABLE m365_signin_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_signin_events FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'm365_signin_events'
      AND policyname = 'm365_signin_events_org_access'
  ) THEN
    CREATE POLICY m365_signin_events_org_access ON public.m365_signin_events
      FOR ALL USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Unguarded on purpose (repo default): a pg_roles existence guard would turn a
-- missing breeze_app role into a SILENT success and resurface later as scattered
-- 42501s. Bare, it aborts loudly with 42704.
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.m365_signin_events TO breeze_app;
