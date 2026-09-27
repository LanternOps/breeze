-- Per-device reported severity/category overlay for device_patches.
--
-- The shared, un-tenanted `patches` row only accepts severity/category from a
-- trusted source (a curated third-party catalog match; see
-- routes/agents/patches.ts upsertPendingPatches/upsertInstalledPatches and
-- services/thirdPartyEnrichment.ts) so one agent can never originate a
-- classification that every other tenant's approval rules then read. That
-- leaves `microsoft`/`apple`/`linux`/`custom` patches at severity 'unknown'
-- and category NULL forever, since no trusted classifier exists for those
-- sources today — Windows severity in particular comes only from the agent's
-- own WUA/MSRC read, so it has nowhere else to land.
--
-- These two nullable columns let each device's agent report its own observed
-- severity/category without ever writing to the shared row. They live on
-- device_patches (device-id scoped, already RLS-covered under that shape), so
-- a device's report only ever affects reads scoped to its own device_id/org_id
-- — never another tenant's view or auto-approval decisions.
ALTER TABLE device_patches
  ADD COLUMN IF NOT EXISTS reported_severity patch_severity,
  ADD COLUMN IF NOT EXISTS reported_category text;
