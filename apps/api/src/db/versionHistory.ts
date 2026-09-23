/**
 * `breeze_version_history`: one row per API version this deployment has booted,
 * with the time it was first seen (#6605). Written only at boot, after
 * migrations, over the migration connection; read by the upgrade preflight.
 *
 * Platform bookkeeping like `breeze_migrations`, not tenant data: no org_id, no
 * RLS. Registered in PLATFORM_INFRASTRUCTURE_TABLES (rls-coverage contract) and
 * CORE_NON_DRIZZLE_TABLES (extensions/tenancyTripwire.ts). The request role
 * keeps SELECT only — ensureAppRole re-revokes writes on every boot.
 */
export const BREEZE_VERSION_HISTORY_TABLE = 'breeze_version_history';
