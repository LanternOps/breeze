-- PAM rule-matching cluster: command-line criterion, rule negation, and a
-- per-org default verdict for unmatched elevations.
--   * pam_rules.match_command_line — case-insensitive substring of the launched
--     process command line (uac_intercept payload carries command_line).
--   * pam_rules.match_negate — jsonb array of criterion keys the engine inverts.
--   * pam_org_config — one row per org; default verdict when nothing matches.
-- File version matching is intentionally NOT included: the agent does not yet
-- capture the binary's file version, so a column would be a dead criterion.
-- Tenancy: pam_org_config is Shape 1 (direct org_id), RLS mirrors pam_rules.
-- Idempotent: re-applying is a no-op.

-- New rule criteria (additive, nullable — no backfill, no shape change).
ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS match_command_line text;
ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS match_negate jsonb;

-- Per-org default verdict for unmatched elevations.
DO $$ BEGIN
  CREATE TYPE pam_unmatched_verdict AS ENUM (
    'require_approval',
    'auto_deny'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pam_org_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy (Shape 1)
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  default_unmatched_verdict pam_unmatched_verdict NOT NULL DEFAULT 'require_approval',

  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One config row per org.
CREATE UNIQUE INDEX IF NOT EXISTS pam_org_config_org_id_unique
  ON pam_org_config (org_id);

-- ============================================================
-- RLS — pam_org_config (Shape 1, mirrors pam_rules #1163)
-- ============================================================
ALTER TABLE pam_org_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE pam_org_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON pam_org_config;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON pam_org_config;
DROP POLICY IF EXISTS breeze_org_isolation_update ON pam_org_config;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON pam_org_config;

CREATE POLICY breeze_org_isolation_select ON pam_org_config
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON pam_org_config
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON pam_org_config
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON pam_org_config
  FOR DELETE USING (public.breeze_has_org_access(org_id));
