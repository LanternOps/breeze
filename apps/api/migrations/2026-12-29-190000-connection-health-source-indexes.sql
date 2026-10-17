-- Connection health W2 (#8846, spec 2026-10-15 §1.3): partial indexes behind
-- the broken-set query of each org-scoped health source, so the reconciler's
-- cost grows with broken connections, not with orgs. Partner-axis connection
-- tables are not indexed (their rows grow with partners).
-- Each predicate must stay implied by the matching source's broken query
-- (services/connectionHealth/sources/*), which writes the constants as literals;
-- connectionHealthSourceIndexes.integration.test.ts EXPLAINs every source.
-- Indexes only, no row writes; scope is elected for uniformity.
SELECT set_config('breeze.scope', 'system', true);

CREATE INDEX IF NOT EXISTS dns_filter_integrations_sync_error_idx
  ON public.dns_filter_integrations (id)
  WHERE is_active AND last_sync_status = 'error';

CREATE INDEX IF NOT EXISTS m365_connections_unhealthy_idx
  ON public.m365_connections (id)
  WHERE org_id IS NOT NULL AND status IN ('degraded', 'suspended');

CREATE INDEX IF NOT EXISTS m365_sync_state_unhealthy_idx
  ON public.m365_sync_state (connection_id)
  WHERE last_status IN ('needs_consent', 'error');
