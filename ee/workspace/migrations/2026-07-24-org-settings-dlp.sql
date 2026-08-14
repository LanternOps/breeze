-- W2: per-org governance settings + DLP-on-ingest columns.
-- workspace_org_settings is org-scoped (RLS shape 1, same as the six content
-- tables in 2026-07-19-content.sql) but keyed directly by org_id (one row per
-- org) rather than a synthetic id — a single settings row per tenant.
-- Idempotent; autoMigrate wraps the file in a transaction — no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS workspace_org_settings (
  org_id uuid PRIMARY KEY,
  content_enabled boolean NOT NULL DEFAULT false,
  dlp_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- DLP-on-ingest findings.
ALTER TABLE workspace_file_content
  ADD COLUMN IF NOT EXISTS dlp_findings jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 'blocked_dlp' becomes a legal value of the existing `status` column.
-- Correction vs the original plan text: status is the workspace_content_status
-- ENUM (not a text column) in this codebase, so it needs an explicit ADD
-- VALUE — see src/schema/content.ts for the drizzle-side note. Safe inside
-- autoMigrate's wrapping transaction (PG12+: ADD VALUE may run in a
-- transaction as long as the new value isn't used in that same transaction,
-- which it isn't here).
ALTER TYPE workspace_content_status ADD VALUE IF NOT EXISTS 'blocked_dlp';

-- RLS: shape 1 (direct org_id) on workspace_org_settings.
DO $$
BEGIN
  ALTER TABLE workspace_org_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE workspace_org_settings FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS breeze_org_isolation_select ON workspace_org_settings;
  DROP POLICY IF EXISTS breeze_org_isolation_insert ON workspace_org_settings;
  DROP POLICY IF EXISTS breeze_org_isolation_update ON workspace_org_settings;
  DROP POLICY IF EXISTS breeze_org_isolation_delete ON workspace_org_settings;
  CREATE POLICY breeze_org_isolation_select ON workspace_org_settings FOR SELECT USING (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_insert ON workspace_org_settings FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_update ON workspace_org_settings FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_delete ON workspace_org_settings FOR DELETE USING (public.breeze_has_org_access(org_id));
END $$;
