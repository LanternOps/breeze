-- Customer Portal Environment Visibility W1 (#8775, spec #8790): physical placement, fail closed for existing and new organizations.
-- Sensitive flag: rack and room reveal the physical layout; never part of the editor's "Enable all".
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_physical_placement boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_branding.enable_physical_placement IS
  'Expose the physical placement (rack and room) of devices and discovered assets in the customer portal. Off by default; sensitive, excluded from Enable all.';
