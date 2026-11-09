-- Connection health staleness (#10021, plan 2026-10-18 PR B): partial indexes
-- behind the dns_filter and m365_sync stale arms, so the reconciler's cost
-- grows with the stalled connections, not with orgs (spec 1.3).
-- They are on plain columns, not on the stale-at expression: under RLS
-- (breeze_app) the planner only pushes leakproof quals into an index, and
-- make_interval / the interval CASE / COALESCE are not. The sources
-- pre-filter on `last_sync < cutoff` (or `created_at < cutoff` while never
-- synced) and recheck the exact interval-based test on what remains; two
-- indexes per table because that is two plain-column arms.
-- connectionHealthSourceIndexes.integration.test.ts EXPLAINs, as the app role,
-- that the planner uses each with an Index Cond.
-- Indexes only, no row writes; scope is elected for uniformity.
SELECT set_config('breeze.scope', 'system', true);

CREATE INDEX IF NOT EXISTS dns_filter_integrations_stale_idx
  ON public.dns_filter_integrations (last_sync)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS dns_filter_integrations_never_synced_idx
  ON public.dns_filter_integrations (created_at)
  WHERE is_active AND last_sync IS NULL;

CREATE INDEX IF NOT EXISTS m365_sync_state_stale_idx
  ON public.m365_sync_state (last_success_at)
  WHERE next_sync_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS m365_sync_state_never_succeeded_idx
  ON public.m365_sync_state (created_at)
  WHERE next_sync_at IS NOT NULL AND last_success_at IS NULL;
