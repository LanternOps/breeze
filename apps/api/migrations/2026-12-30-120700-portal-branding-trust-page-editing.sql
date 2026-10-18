-- Trust Center W3d (#8771): portal permission flag for customer trust-page
-- editing. Org-scoped admin contacts with a portal login may edit part of the
-- trust page draft (contact email, website, hidden controls, two exposure
-- toggles), mint a preview and unpublish; publishing stays with the MSP.
-- Fail closed for existing and new organizations. DDL only: no row writes, so
-- no breeze.scope election is needed.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_trust_page_editing boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_branding.enable_trust_page_editing IS
  'Let the customer''s org-admin contacts edit parts of the trust page draft from the portal. Off by default.';
