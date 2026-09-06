-- #4100: webhook_deliveries.webhook_id -> webhooks.id has no ON DELETE action
-- (defaults to NO ACTION), while `webhooks` IS registered in
-- CORE_ORG_CASCADE_DELETE_ORDER (tenantCascade.ts). The moment an org's
-- webhook has ever recorded a delivery, org erasure's DELETE FROM webhooks
-- raises a 23503 FK violation and the whole erasure aborts.
--
-- Fix: ON DELETE CASCADE. Delivery rows are worthless without their webhook
-- (they exist purely to record/replay a POST for a webhook that itself just
-- got deleted), so cascading them is correct, not just convenient. This is
-- the same shape as software_install_methods.catalog_id (see
-- tenantCascade.ts's ASSOCIATED_SYSTEM_SCOPED_TABLES comment) — a DB-level
-- ON DELETE CASCADE needs no entry in the erasure pre-clear list, the
-- org-merge registry, or the export-policy registry, because the cascade
-- deletes the child automatically when the parent goes, and merge only
-- repoints `webhooks.org_id` (webhook_deliveries has no org_id column of its
-- own; it travels with its parent's id, which merge never changes).
--
-- webhook_deliveries already carries RLS (PARENT_FK_JOIN_POLICY_TABLES,
-- PR #1290) — untouched here.
ALTER TABLE webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_webhook_id_webhooks_id_fk;
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_webhook_id_webhooks_id_fk
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE;
