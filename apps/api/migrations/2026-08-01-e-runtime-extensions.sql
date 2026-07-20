-- Runtime extension platform: persistent state + schema-history tables (Plan 02,
-- Task 2). The reconciler and migrator (later tasks) read/write these through
-- the `ExtensionStateStore`; this migration only creates the storage.
--
-- Both tables are core-owned GLOBAL operational tables — there is no tenant/org
-- axis. Per the tenancy contract, a core `public` table must have either tenant
-- RLS or a correct global-table setup, so each table gets:
--   ENABLE + FORCE ROW LEVEL SECURITY, plus a single system-only policy
--   (`<table>_system_only`) gated on current_setting('breeze.scope', true) =
--   'system'. A forced table with ZERO policies denies even the system
--   `breeze_app` role, so the policy is mandatory — mirrors the
--   `vulnerability_sources` global-table block in
--   2026-06-22-vulnerability-management.sql. Every ExtensionStateStore operation
--   runs under withSystemDbAccessContext so the policy admits it.

-- installed_extensions: one row per known extension, tracking the version/trust
-- facts OBSERVED from the deployment config + verified bundle, the runtime
-- enabled flag, and the lifecycle state. Keyed by extension name.
CREATE TABLE IF NOT EXISTS installed_extensions (
  name text PRIMARY KEY,
  configured_version text,
  active_version text,
  artifact_digest text,
  publisher_id text,
  manifest_api_version text,
  server_sdk_version text,
  web_sdk_version text,
  enabled boolean NOT NULL DEFAULT true,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN (
    'discovered','verified','migrated','active','disabled','failed','incompatible'
  )),
  last_error_category text,
  last_error_message text,
  migrated_at timestamptz,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- extension_schema_history: append-only record of the schema-compatibility floor
-- each bundle version applied, so the migrator never re-applies a floor and can
-- compute the highest floor ever seen for an extension. Keyed (name, version).
CREATE TABLE IF NOT EXISTS extension_schema_history (
  extension_name text NOT NULL,
  bundle_version text NOT NULL,
  schema_compatibility_floor text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_name, bundle_version)
);

-- Global tables: force RLS + a system-only policy (system context only; all
-- tenants denied). A forced table with NO policy denies everyone INCLUDING the
-- system context, because the API connects as the non-BYPASSRLS `breeze_app`
-- role — so these tables need the same system-only policy as
-- `vulnerability_sources` (2026-06-22), not zero policies.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['installed_extensions','extension_schema_history']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_system_only', t);
    EXECUTE format(
      $f$CREATE POLICY %I ON %I USING (current_setting('breeze.scope', true) = 'system') WITH CHECK (current_setting('breeze.scope', true) = 'system')$f$,
      t || '_system_only', t
    );
  END LOOP;
END $$;
