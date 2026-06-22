-- #1736 — surface Huntress sync results in the UI.
-- The sync job returns per-run counts (agents/incidents upserted, orgs
-- discovered) but nothing persisted them, so the Coverage UI could not show
-- "synced N agents / M incidents" and a queued, enqueue-only sync gave the user
-- no feedback about whether it actually succeeded. Persist the last successful
-- run's counts on the integration row so GET /huntress/integration can return
-- them and the UI can poll to a terminal state and display the result.
ALTER TABLE huntress_integrations
  ADD COLUMN IF NOT EXISTS last_sync_agents integer;
ALTER TABLE huntress_integrations
  ADD COLUMN IF NOT EXISTS last_sync_incidents integer;
ALTER TABLE huntress_integrations
  ADD COLUMN IF NOT EXISTS last_sync_orgs integer;
