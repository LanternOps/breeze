-- AI model registry W03 (#7601, spec §6): per-offering discovery state for
-- connection offerings (syncConnectionModels). The lifecycle rule is W01's
-- (computeLifecycleAfterSync): absent from 3 consecutive SUCCESSFUL syncs and
-- at least 48 h -> `missing`; absent 14 days -> `retired`.
--
-- last_seen_at stays NULL until a sync actually observes the model. A row no
-- sync has seen (projected/backfilled offerings, aliases the Models API does
-- not list, manual rows) is never aged (W01's never-seen guard), so there is
-- deliberately no backfill here: DDL only, no rows written.
--
-- partner_ai_models is partner-axis (no org_id): no org cascade, merge or
-- export-policy entry applies. Idempotent.
ALTER TABLE partner_ai_models ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NULL;
ALTER TABLE partner_ai_models ADD COLUMN IF NOT EXISTS missed_sync_count integer NOT NULL DEFAULT 0;
