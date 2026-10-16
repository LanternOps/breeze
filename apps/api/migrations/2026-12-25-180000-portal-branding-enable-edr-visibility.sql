-- EDR provider framework W02 (#8166): strict portal flag for the vendor-neutral
-- "Managed endpoint protection" leg of the portal security read model.
-- Fail closed for existing and new organizations. DDL only: no row writes, so no
-- breeze.scope election is needed.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_edr_visibility boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_branding.enable_edr_visibility IS
  'Let managed endpoint protection (EDR) state count toward the customer portal security view. Vendor-neutral label only. Off by default.';
