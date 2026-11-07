-- EDR provider framework W06.1 (#8170): installer dispatch for framework providers.
--
-- 1. software_catalog.integration_provider admits every EDR provider key, not
--    only the installer-capable ones. Whether a vendor can supply an installer
--    is the adapter's capabilities.installer; a later installer-capable adapter
--    then needs no migration. Supersedes the 2026-07-02 definition.
-- 2. edr_tenants gains non-secret installer status. The sealed material itself
--    stays in installer_secret_encrypted; installer_fetch_error holds a code from
--    EDR_INSTALLER_FETCH_ERROR_CODES, never vendor text.
--
-- edr_tenants keeps its partner-axis policies from
-- 2026-12-16-100000-edr-provider-framework.sql. This file writes no rows.

ALTER TABLE software_catalog
  DROP CONSTRAINT IF EXISTS software_catalog_integration_provider_chk;
ALTER TABLE software_catalog
  ADD CONSTRAINT software_catalog_integration_provider_chk
  CHECK (integration_provider IS NULL OR integration_provider IN ('huntress', 'sentinelone', 'bitdefender', 'emsisoft'));

ALTER TABLE edr_tenants
  ADD COLUMN IF NOT EXISTS installer_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS installer_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS installer_fetch_error varchar(40);
