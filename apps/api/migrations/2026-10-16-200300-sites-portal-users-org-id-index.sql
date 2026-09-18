-- #5732: sites / portal_users have no org_id-leading index, so
-- GET /orgs/account-readiness (#5721 W01) sequential-scans both tables when
-- it groups by org_id over a partner's accepted org ids. Every other domain
-- read by that endpoint (devices, contacts, tickets, invoices,
-- config_policy_assignments) is already index-backed on org_id.
--
-- `sites` only has sites_id_org_id_uniq, which leads with id, not org_id, so
-- it can't be used to seek by org_id. `portal_users` has no org_id index at
-- all. EXPLAIN (ANALYZE, BUFFERS) evidence in the issue (2,000-org / 50k-device
-- seed, as breeze_app under a partner RLS context) shows both tables
-- sequential-scanning; not urgent today (~13-26ms), but it becomes a real
-- cost as a partner's site/portal-user counts grow.
--
-- Idempotent, plain (non-partial) indexes — safe to re-apply.
CREATE INDEX IF NOT EXISTS sites_org_id_idx ON sites (org_id);
CREATE INDEX IF NOT EXISTS portal_users_org_id_idx ON portal_users (org_id);
