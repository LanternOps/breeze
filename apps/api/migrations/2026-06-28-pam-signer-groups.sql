-- Reusable trusted-publisher catalog (signer groups).
--   * pam_signer_groups — per-org named set of signer (subject CN) patterns.
--   * pam_rules.match_signer_group_id — reference a group as an alternative to
--     match_signer (the rule matches when the candidate signer equals ANY
--     member). Mutually exclusive with match_signer (enforced at the API layer).
-- Resolution is entirely server-side; the agent never receives groups.
-- Tenancy: pam_signer_groups is Shape 1 (direct org_id), RLS mirrors pam_rules.
-- Idempotent: re-applying is a no-op.

CREATE TABLE IF NOT EXISTS pam_signer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy (Shape 1)
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name varchar(255) NOT NULL,
  description text,
  -- Signer subject-CN patterns; matched case-insensitively, exact.
  signers jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One group name per org.
CREATE UNIQUE INDEX IF NOT EXISTS pam_signer_groups_org_id_name_unique
  ON pam_signer_groups (org_id, name);

-- Reference a group from a rule. ON DELETE RESTRICT: a group in use cannot be
-- deleted out from under its rules (the API layer surfaces a clean 409).
ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS match_signer_group_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pam_rules_match_signer_group_id_fkey'
  ) THEN
    ALTER TABLE pam_rules
      ADD CONSTRAINT pam_rules_match_signer_group_id_fkey
      FOREIGN KEY (match_signer_group_id) REFERENCES pam_signer_groups(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ============================================================
-- RLS — pam_signer_groups (Shape 1, mirrors pam_rules #1163)
-- ============================================================
ALTER TABLE pam_signer_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pam_signer_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON pam_signer_groups;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON pam_signer_groups;
DROP POLICY IF EXISTS breeze_org_isolation_update ON pam_signer_groups;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON pam_signer_groups;

CREATE POLICY breeze_org_isolation_select ON pam_signer_groups
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON pam_signer_groups
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON pam_signer_groups
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON pam_signer_groups
  FOR DELETE USING (public.breeze_has_org_access(org_id));
