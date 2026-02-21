BEGIN;

-- Prevent duplicate playbook names in the same scope:
-- - org-specific: unique per org
-- - built-in (org_id NULL): unique globally
CREATE UNIQUE INDEX IF NOT EXISTS playbook_definitions_scope_name_uniq
  ON playbook_definitions ((COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name));

ALTER TABLE playbook_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbook_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE playbook_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbook_executions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS playbook_definitions_select ON playbook_definitions;
DROP POLICY IF EXISTS playbook_definitions_insert ON playbook_definitions;
DROP POLICY IF EXISTS playbook_definitions_update ON playbook_definitions;
DROP POLICY IF EXISTS playbook_definitions_delete ON playbook_definitions;

CREATE POLICY playbook_definitions_select
  ON playbook_definitions
  FOR SELECT
  USING (
    public.breeze_current_scope() <> 'none'
    AND (
      public.breeze_has_org_access(org_id)
      OR (is_built_in = true AND org_id IS NULL)
    )
  );

CREATE POLICY playbook_definitions_insert
  ON playbook_definitions
  FOR INSERT
  WITH CHECK (
    (public.breeze_has_org_access(org_id) AND COALESCE(is_built_in, false) = false)
    OR (public.breeze_current_scope() = 'system' AND is_built_in = true AND org_id IS NULL)
  );

CREATE POLICY playbook_definitions_update
  ON playbook_definitions
  FOR UPDATE
  USING (
    (public.breeze_has_org_access(org_id) AND COALESCE(is_built_in, false) = false)
    OR (public.breeze_current_scope() = 'system' AND is_built_in = true AND org_id IS NULL)
  )
  WITH CHECK (
    (public.breeze_has_org_access(org_id) AND COALESCE(is_built_in, false) = false)
    OR (public.breeze_current_scope() = 'system' AND is_built_in = true AND org_id IS NULL)
  );

CREATE POLICY playbook_definitions_delete
  ON playbook_definitions
  FOR DELETE
  USING (
    (public.breeze_has_org_access(org_id) AND COALESCE(is_built_in, false) = false)
    OR (public.breeze_current_scope() = 'system' AND is_built_in = true AND org_id IS NULL)
  );

DROP POLICY IF EXISTS playbook_executions_select ON playbook_executions;
DROP POLICY IF EXISTS playbook_executions_insert ON playbook_executions;
DROP POLICY IF EXISTS playbook_executions_update ON playbook_executions;
DROP POLICY IF EXISTS playbook_executions_delete ON playbook_executions;

CREATE POLICY playbook_executions_select
  ON playbook_executions
  FOR SELECT
  USING (public.breeze_has_org_access(org_id));

CREATE POLICY playbook_executions_insert
  ON playbook_executions
  FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY playbook_executions_update
  ON playbook_executions
  FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY playbook_executions_delete
  ON playbook_executions
  FOR DELETE
  USING (public.breeze_has_org_access(org_id));

COMMIT;
