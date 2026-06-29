-- Link Breeze organizations back to the external accounting customer they were
-- imported from, so re-imports are idempotent. Generic (provider, external_id)
-- so Xero can reuse it later. Partial unique index enforces "skip dupes" even
-- under concurrent imports. Does not change the org RLS tenancy shape.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS accounting_provider text;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS accounting_external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_accounting_external_uniq
  ON organizations (partner_id, accounting_provider, accounting_external_id)
  WHERE accounting_external_id IS NOT NULL;
