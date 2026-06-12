-- PAM-native rules table (#1163).
-- The Rules tab of the /pam admin UI manages these; ingest evaluates them
-- when no software_policy binds (services/pamRuleEngine.ts).
-- Tenancy: Shape 1 (direct org_id), RLS mirrors elevation_requests (#905).
-- Idempotent: re-applying is a no-op.

DO $$ BEGIN
  CREATE TYPE pam_rule_verdict AS ENUM (
    'auto_approve',
    'auto_deny',
    'require_approval',
    'ignore'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pam_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy (Shape 1)
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid REFERENCES sites(id),

  name varchar(255) NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,

  -- Lower number = evaluated first. Ties broken by created_at then id.
  priority integer NOT NULL DEFAULT 100,

  -- Match criteria — all provided criteria must match (AND).
  match_signer varchar(255),
  match_hash varchar(64),
  match_path_glob text,
  match_parent_image text,
  match_user varchar(255),
  match_ad_group varchar(255),
  time_window jsonb,

  verdict pam_rule_verdict NOT NULL,

  approval_duration_minutes integer,

  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pam_rules_org_id_idx ON pam_rules (org_id);
CREATE INDEX IF NOT EXISTS pam_rules_org_enabled_priority_idx
  ON pam_rules (org_id, enabled, priority);

-- ============================================================
-- RLS — pam_rules (Shape 1, mirrors elevation_requests #905)
-- ============================================================
ALTER TABLE pam_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pam_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON pam_rules;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON pam_rules;
DROP POLICY IF EXISTS breeze_org_isolation_update ON pam_rules;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON pam_rules;

CREATE POLICY breeze_org_isolation_select ON pam_rules
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON pam_rules
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON pam_rules
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON pam_rules
  FOR DELETE USING (public.breeze_has_org_access(org_id));
