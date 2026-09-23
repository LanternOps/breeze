-- #6605: upgrade preflight — record which API versions this deployment has run.
--
-- One row per version, written once at boot after migrations succeed
-- (INSERT ... ON CONFLICT (version) DO NOTHING keeps the first sighting). The
-- next upgrade's preflight reads it to tell the operator exactly which
-- retirements in the image's breaking-change manifest the upgrade crosses.
--
-- Platform bookkeeping, like breeze_migrations: no org_id, no tenant data, no
-- RLS. Intentionally system-scoped — registered in PLATFORM_INFRASTRUCTURE_TABLES
-- (rls-coverage.integration.test.ts) and justified in
-- docs/superpowers/plans/platform-ci/2026-09-22-upgrade-preflight-6605.md.
-- The request role (breeze_app) keeps SELECT only; ensureAppRole re-revokes
-- INSERT/UPDATE/DELETE/TRUNCATE on every boot, because its blanket grant would
-- otherwise restore them.

CREATE TABLE IF NOT EXISTS breeze_version_history (
  version TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT breeze_version_history_version_len_chk CHECK (char_length(version) BETWEEN 1 AND 64)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE breeze_version_history FROM breeze_app;
    GRANT SELECT ON TABLE breeze_version_history TO breeze_app;
  END IF;
END $$;
