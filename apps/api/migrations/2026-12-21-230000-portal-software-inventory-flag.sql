-- Portal Advanced Visibility W04 (#7734): fail closed for existing and new organizations.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_software_inventory boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_branding.enable_software_inventory IS
  'Expose read-only software inventory in the customer portal. Off by default.';
