-- apps/api/migrations/2026-12-28-140000-ai-data-policies.sql
-- AI device file read policy (spec 2026-10-15). Dual-owner config table
-- (#2135 Partner-Wide First): the PARTNER row is the default/ceiling for
-- every org under it, the ORG row may only tighten. NULL on an org row =
-- inherit. NULL retention on a partner row = keep forever.
-- Idempotent. No inner BEGIN/COMMIT. Writes no rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_device_file_read_level') THEN
    CREATE TYPE ai_device_file_read_level AS ENUM ('off', 'no_user_profiles', 'any_with_approval');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_data_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  device_file_read_level ai_device_file_read_level,
  tool_output_retention_days integer,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_data_policies_one_owner_chk') THEN
    ALTER TABLE ai_data_policies
      ADD CONSTRAINT ai_data_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_data_policies_retention_chk') THEN
    ALTER TABLE ai_data_policies
      ADD CONSTRAINT ai_data_policies_retention_chk
      CHECK (tool_output_retention_days IS NULL OR tool_output_retention_days >= 1);
  END IF;
END $$;

-- Total uniques: NULLs never collide, so partner rows and org rows coexist,
-- and a total UNIQUE on org_id is what org-merge `keep-survivor` needs.
CREATE UNIQUE INDEX IF NOT EXISTS ai_data_policies_org_uq ON ai_data_policies (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_data_policies_partner_uq ON ai_data_policies (partner_id);

ALTER TABLE ai_data_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_data_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_data_policies_isolation ON ai_data_policies;
CREATE POLICY ai_data_policies_isolation ON ai_data_policies
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- SEPARATE, SELECT-only partner-wide read branch. Never appended to the
-- FOR ALL policy (that would widen UPDATE/DELETE targeting).
DROP POLICY IF EXISTS ai_data_policies_partner_wide_select ON ai_data_policies;
CREATE POLICY ai_data_policies_partner_wide_select
  ON ai_data_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_data_policies TO breeze_app;
