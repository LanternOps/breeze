-- #11502 (feature #11500, W02): record how many UniFi sites a cloud sync run
-- saw with no Breeze mapping, so the sync history shows unmapped-site drift.
--
-- unifi_sync_runs is partner-axis (partner_id, no org_id): no org cascade,
-- org-merge or tenant-export registration applies, and its RLS policies are
-- unchanged. Nullable on purpose: NULL means "not recorded" (runs before this
-- column, failed runs, runs with no mappings, which read no site list, and runs
-- whose site list had dropped or hostless rows, so the count is unknown).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); no inner BEGIN/COMMIT.
-- DDL only: it writes no rows, so it needs no breeze.scope system election.

ALTER TABLE unifi_sync_runs ADD COLUMN IF NOT EXISTS sites_unmapped integer;
