-- Installer terms-of-use acceptance audit trail.
--
-- The macOS DMG installer shows a terms screen before it calls
-- POST /api/v1/installer/bootstrap. These three OPTIONAL, additive columns
-- record what the end user agreed to, so an operator can later evidence that
-- a given enrollment was preceded by an acceptance.
--
-- All three are nullable with no default: older installers (and the Windows
-- MSI path) omit them entirely and must keep working. NULL therefore means
-- "installer did not report acceptance", never "declined".
--
-- No RLS/cascade/index changes: installer_bootstrap_tokens already has RLS,
-- is already in CORE_ORG_CASCADE_DELETE_ORDER, and these columns are not
-- queried. The columns ARE classified in CORE_TENANT_EXPORT_POLICY
-- (services/tenantExportPolicyRegistry.ts) in the same change.

ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS accepted_terms boolean;

ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS accepted_terms_at timestamptz;

ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS terms_url text;

COMMENT ON COLUMN installer_bootstrap_tokens.accepted_terms IS
  'Installer-reported terms acceptance. NULL = not reported (older installer).';
COMMENT ON COLUMN installer_bootstrap_tokens.accepted_terms_at IS
  'Client-reported acceptance timestamp (ISO8601 from the installer). NULL = not reported.';
COMMENT ON COLUMN installer_bootstrap_tokens.terms_url IS
  'URL of the terms document the installer displayed. NULL = not reported.';
