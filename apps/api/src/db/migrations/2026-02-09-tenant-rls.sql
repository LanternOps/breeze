-- Enforce organization-level row isolation across tenant-owned tables.
-- This migration applies to all public tables that contain an org_id column.

BEGIN;

CREATE OR REPLACE FUNCTION public.breeze_current_scope()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('breeze.scope', true), ''), 'system');
$$;

CREATE OR REPLACE FUNCTION public.breeze_accessible_org_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.accessible_org_ids', true);

  -- "*" means unrestricted org access (system scope).
  IF raw = '*' THEN
    RETURN NULL;
  END IF;

  -- Empty/missing means no org access.
  IF raw IS NULL OR raw = '' THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  RETURN string_to_array(raw, ',')::uuid[];
EXCEPTION
  WHEN others THEN
    -- Fail closed on malformed values.
    RETURN ARRAY[]::uuid[];
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_has_org_access(target_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN public.breeze_current_scope() = 'system' THEN TRUE
    WHEN target_org_id IS NULL THEN FALSE
    ELSE COALESCE(target_org_id = ANY(public.breeze_accessible_org_ids()), FALSE)
  END;
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    INNER JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'org_id'
    GROUP BY c.table_schema, c.table_name
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.table_schema, r.table_name);

    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I.%I', r.table_schema, r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I.%I', r.table_schema, r.table_name);

    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_select ON %I.%I FOR SELECT USING (public.breeze_has_org_access(org_id))',
      r.table_schema,
      r.table_name
    );
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_insert ON %I.%I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))',
      r.table_schema,
      r.table_name
    );
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_update ON %I.%I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',
      r.table_schema,
      r.table_name
    );
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_delete ON %I.%I FOR DELETE USING (public.breeze_has_org_access(org_id))',
      r.table_schema,
      r.table_name
    );
  END LOOP;
END;
$$;

COMMIT;
