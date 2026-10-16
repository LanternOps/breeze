-- Portal Advanced Visibility W05 (#7735): patch detail, fail closed for existing and new organizations.
-- Sensitive flag: never part of the editor's "Enable all".
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_patch_detail boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_branding.enable_patch_detail IS
  'Expose read-only per-host patch status (pending, installed, failed) in the customer portal. Off by default; sensitive, excluded from Enable all.';
