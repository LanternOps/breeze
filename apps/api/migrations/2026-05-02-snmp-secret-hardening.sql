DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'snmp_devices'
      AND column_name = 'community'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE snmp_devices
      ALTER COLUMN community TYPE text;
  END IF;
END $$;

ALTER TABLE snmp_templates
  ADD COLUMN IF NOT EXISTS org_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'snmp_templates_org_id_organizations_id_fk'
  ) THEN
    ALTER TABLE snmp_templates
      ADD CONSTRAINT snmp_templates_org_id_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS snmp_templates_org_id_idx
  ON snmp_templates(org_id);

ALTER TABLE snmp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE snmp_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS snmp_templates_select ON snmp_templates;
DROP POLICY IF EXISTS snmp_templates_insert ON snmp_templates;
DROP POLICY IF EXISTS snmp_templates_update ON snmp_templates;
DROP POLICY IF EXISTS snmp_templates_delete ON snmp_templates;

CREATE POLICY snmp_templates_select ON snmp_templates
  FOR SELECT
  USING (
    is_built_in = true
    OR public.breeze_has_org_access(org_id)
    OR (public.breeze_current_scope() = 'system' AND org_id IS NULL)
  );

CREATE POLICY snmp_templates_insert ON snmp_templates
  FOR INSERT
  WITH CHECK (
    (COALESCE(is_built_in, false) = false AND public.breeze_has_org_access(org_id))
    OR (public.breeze_current_scope() = 'system' AND org_id IS NULL)
  );

CREATE POLICY snmp_templates_update ON snmp_templates
  FOR UPDATE
  USING (
    (COALESCE(is_built_in, false) = false AND public.breeze_has_org_access(org_id))
    OR (public.breeze_current_scope() = 'system' AND org_id IS NULL)
  )
  WITH CHECK (
    (COALESCE(is_built_in, false) = false AND public.breeze_has_org_access(org_id))
    OR (public.breeze_current_scope() = 'system' AND org_id IS NULL)
  );

CREATE POLICY snmp_templates_delete ON snmp_templates
  FOR DELETE
  USING (
    (COALESCE(is_built_in, false) = false AND public.breeze_has_org_access(org_id))
    OR (public.breeze_current_scope() = 'system' AND org_id IS NULL)
  );
