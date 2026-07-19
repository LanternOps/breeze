-- Serialize the normalized OneDrive ownership chain inside the feature
-- reference namespace.  Every writer derives the complete physical chain:
-- feature link -> configuration policy -> settings -> libraries.  Reverse
-- triggers run before the general feature-reference trigger, so namespace
-- 1000302 is always entered once with the complete sorted key set.

CREATE OR REPLACE FUNCTION public.breeze_enforce_onedrive_settings_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Prod migrates as a non-superuser that cannot SET custom breeze.* GUCs as
  -- function attributes (42501), so elevate in-body — after the transition-
  -- table-only no-op gates — and restore the caller's context before every
  -- normal return. breeze.* is held for the whole request transaction, so a
  -- leaked 'system' scope would be an RLS hole; error paths restore
  -- automatically via (sub)transaction rollback.
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  row_values jsonb[] := ARRAY[]::jsonb[];
  new_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
    new_values := row_values;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT EXISTS (
      (SELECT id, feature_link_id, org_id FROM old_rows
       EXCEPT SELECT id, feature_link_id, org_id FROM new_rows)
      UNION ALL
      (SELECT id, feature_link_id, org_id FROM new_rows
       EXCEPT SELECT id, feature_link_id, org_id FROM old_rows)
    ) THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO new_values FROM new_rows row;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL
      SELECT value FROM unnest(new_values) value
    ) rows;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Elevate only here: everything above reads nothing but transition tables,
  -- so the no-op RETURN NULL path carries no scope to restore.
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);

  -- Stabilize existing rows in one closed relation order before 1000302.
  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN (
    SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = link.id
  ORDER BY link.id
  FOR KEY SHARE OF link;

  PERFORM policy.id
  FROM public.configuration_policies policy
  JOIN public.config_policy_feature_links link ON link.config_policy_id = policy.id
  JOIN (
    SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = link.id
  ORDER BY policy.id
  FOR KEY SHARE OF policy;

  PERFORM settings.id
  FROM public.config_policy_onedrive_settings settings
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) requested ON requested.id = settings.id
  ORDER BY settings.id
  FOR KEY SHARE OF settings;

  PERFORM library.id
  FROM public.config_policy_onedrive_libraries library
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) requested ON requested.id = library.settings_id
  ORDER BY library.id
  FOR KEY SHARE OF library;

  FOR lock_key IN
    WITH settings_rows AS (
      SELECT DISTINCT (value->>'id')::uuid AS id,
        (value->>'feature_link_id')::uuid AS feature_link_id
      FROM unnest(row_values) value
    ), links AS (
      SELECT DISTINCT link.id, link.config_policy_id
      FROM public.config_policy_feature_links link
      JOIN settings_rows ON settings_rows.feature_link_id = link.id
    ), libraries AS (
      SELECT DISTINCT library.id
      FROM public.config_policy_onedrive_libraries library
      JOIN settings_rows ON settings_rows.id = library.settings_id
    ), identities AS (
      SELECT 'feature-link:' || feature_link_id::text AS identity FROM settings_rows
      UNION SELECT 'policy:' || config_policy_id::text FROM links
      UNION SELECT 'onedrive-settings:' || id::text FROM settings_rows
      UNION SELECT 'onedrive-library:' || id::text FROM libraries
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  IF TG_OP <> 'DELETE' THEN
    FOR candidate IN
      SELECT settings.feature_link_id, settings.org_id
      FROM public.config_policy_onedrive_settings settings
      JOIN (
        SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(new_values) value
      ) changed ON changed.id = settings.id
      ORDER BY settings.id
    LOOP
      PERFORM public.breeze_validate_config_policy_onedrive_settings(
        candidate.feature_link_id, candidate.org_id
      );
    END LOOP;
  END IF;

  -- A settings owner/identity move is also a reverse write for every library.
  FOR candidate IN
    SELECT library.settings_id, library.org_id
    FROM public.config_policy_onedrive_libraries library
    JOIN (
      SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
    ) changed ON changed.id = library.settings_id
    ORDER BY library.id
  LOOP
    PERFORM public.breeze_validate_config_policy_onedrive_library(
      candidate.settings_id, candidate.org_id
    );
  END LOOP;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_onedrive_library_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  row_values jsonb[] := ARRAY[]::jsonb[];
  new_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
    new_values := row_values;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT EXISTS (
      (SELECT id, settings_id, org_id FROM old_rows
       EXCEPT SELECT id, settings_id, org_id FROM new_rows)
      UNION ALL
      (SELECT id, settings_id, org_id FROM new_rows
       EXCEPT SELECT id, settings_id, org_id FROM old_rows)
    ) THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO new_values FROM new_rows row;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL
      SELECT value FROM unnest(new_values) value
    ) rows;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Elevate only here: everything above reads nothing but transition tables,
  -- so the no-op RETURN NULL path carries no scope to restore.
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);

  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN public.config_policy_onedrive_settings settings ON settings.feature_link_id = link.id
  JOIN (
    SELECT DISTINCT (value->>'settings_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = settings.id
  ORDER BY link.id
  FOR KEY SHARE OF link;

  PERFORM policy.id
  FROM public.configuration_policies policy
  JOIN public.config_policy_feature_links link ON link.config_policy_id = policy.id
  JOIN public.config_policy_onedrive_settings settings ON settings.feature_link_id = link.id
  JOIN (
    SELECT DISTINCT (value->>'settings_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = settings.id
  ORDER BY policy.id
  FOR KEY SHARE OF policy;

  PERFORM settings.id
  FROM public.config_policy_onedrive_settings settings
  JOIN (
    SELECT DISTINCT (value->>'settings_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = settings.id
  ORDER BY settings.id
  FOR KEY SHARE OF settings;

  PERFORM library.id
  FROM public.config_policy_onedrive_libraries library
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) requested ON requested.id = library.id
  ORDER BY library.id
  FOR KEY SHARE OF library;

  FOR lock_key IN
    WITH library_rows AS (
      SELECT DISTINCT (value->>'id')::uuid AS id,
        (value->>'settings_id')::uuid AS settings_id
      FROM unnest(row_values) value
    ), settings_rows AS (
      SELECT DISTINCT settings.id, settings.feature_link_id
      FROM public.config_policy_onedrive_settings settings
      JOIN library_rows ON library_rows.settings_id = settings.id
    ), links AS (
      SELECT DISTINCT link.id, link.config_policy_id
      FROM public.config_policy_feature_links link
      JOIN settings_rows ON settings_rows.feature_link_id = link.id
    ), identities AS (
      SELECT 'feature-link:' || feature_link_id::text AS identity FROM settings_rows
      UNION SELECT 'policy:' || config_policy_id::text FROM links
      UNION SELECT 'onedrive-settings:' || settings_id::text FROM library_rows
      UNION SELECT 'onedrive-library:' || id::text FROM library_rows
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  IF TG_OP <> 'DELETE' THEN
    FOR candidate IN
      SELECT library.settings_id, library.org_id
      FROM public.config_policy_onedrive_libraries library
      JOIN (
        SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(new_values) value
      ) changed ON changed.id = library.id
      ORDER BY library.id
    LOOP
      PERFORM public.breeze_validate_config_policy_onedrive_library(
        candidate.settings_id, candidate.org_id
      );
    END LOOP;
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_revalidate_onedrive_parent_statements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  row_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME NOT IN ('config_policy_feature_links', 'configuration_policies') THEN
    RAISE EXCEPTION 'unsupported OneDrive reverse parent: %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'config_policy_feature_links' THEN
      IF NOT EXISTS (
        (SELECT id, config_policy_id, feature_type FROM old_rows
         EXCEPT SELECT id, config_policy_id, feature_type FROM new_rows)
        UNION ALL
        (SELECT id, config_policy_id, feature_type FROM new_rows
         EXCEPT SELECT id, config_policy_id, feature_type FROM old_rows)
      ) THEN RETURN NULL; END IF;
    ELSE
      IF NOT EXISTS (
        (SELECT id, org_id, partner_id FROM old_rows
         EXCEPT SELECT id, org_id, partner_id FROM new_rows)
        UNION ALL
        (SELECT id, org_id, partner_id FROM new_rows
         EXCEPT SELECT id, org_id, partner_id FROM old_rows)
      ) THEN RETURN NULL; END IF;
    END IF;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL
      SELECT to_jsonb(row) AS value FROM new_rows row
    ) rows;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Elevate only here: everything above reads nothing but transition tables,
  -- so the no-op RETURN NULL path carries no scope to restore.
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);

  -- The parent statement already owns its changed rows. Lock every currently
  -- visible descendant in the same physical order used by child writers.
  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) changed ON (
    TG_TABLE_NAME = 'config_policy_feature_links' AND changed.id = link.id
  ) OR (
    TG_TABLE_NAME = 'configuration_policies' AND changed.id = link.config_policy_id
  )
  ORDER BY link.id
  FOR KEY SHARE OF link;

  PERFORM policy.id
  FROM public.configuration_policies policy
  JOIN (
    SELECT DISTINCT CASE TG_TABLE_NAME
      WHEN 'config_policy_feature_links' THEN (value->>'config_policy_id')::uuid
      ELSE (value->>'id')::uuid
    END AS id
    FROM unnest(row_values) value
  ) changed ON changed.id = policy.id
  ORDER BY policy.id
  FOR KEY SHARE OF policy;

  PERFORM settings.id
  FROM public.config_policy_onedrive_settings settings
  JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) changed ON (
    TG_TABLE_NAME = 'config_policy_feature_links' AND changed.id = link.id
  ) OR (
    TG_TABLE_NAME = 'configuration_policies' AND changed.id = link.config_policy_id
  )
  ORDER BY settings.id
  FOR KEY SHARE OF settings;

  PERFORM library.id
  FROM public.config_policy_onedrive_libraries library
  JOIN public.config_policy_onedrive_settings settings ON settings.id = library.settings_id
  JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
  JOIN (
    SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
  ) changed ON (
    TG_TABLE_NAME = 'config_policy_feature_links' AND changed.id = link.id
  ) OR (
    TG_TABLE_NAME = 'configuration_policies' AND changed.id = link.config_policy_id
  )
  ORDER BY library.id
  FOR KEY SHARE OF library;

  FOR lock_key IN
    WITH changed_rows AS (
      SELECT DISTINCT value FROM unnest(row_values) value
    ), affected_links AS (
      SELECT DISTINCT link.id, link.config_policy_id
      FROM public.config_policy_feature_links link
      JOIN changed_rows changed ON (
        TG_TABLE_NAME = 'config_policy_feature_links'
        AND (changed.value->>'id')::uuid = link.id
      ) OR (
        TG_TABLE_NAME = 'configuration_policies'
        AND (changed.value->>'id')::uuid = link.config_policy_id
      )
      UNION
      SELECT DISTINCT (value->>'id')::uuid,
        (value->>'config_policy_id')::uuid
      FROM changed_rows
      WHERE TG_TABLE_NAME = 'config_policy_feature_links'
    ), affected_policies AS (
      SELECT config_policy_id AS id FROM affected_links
      UNION
      SELECT DISTINCT (value->>'id')::uuid FROM changed_rows
      WHERE TG_TABLE_NAME = 'configuration_policies'
    ), affected_settings AS (
      SELECT DISTINCT settings.id, settings.feature_link_id
      FROM public.config_policy_onedrive_settings settings
      JOIN affected_links ON affected_links.id = settings.feature_link_id
    ), affected_libraries AS (
      SELECT DISTINCT library.id
      FROM public.config_policy_onedrive_libraries library
      JOIN affected_settings ON affected_settings.id = library.settings_id
    ), identities AS (
      SELECT 'feature-link:' || id::text AS identity FROM affected_links
      UNION SELECT 'policy:' || id::text FROM affected_policies
      UNION SELECT 'onedrive-settings:' || id::text FROM affected_settings
      UNION SELECT 'onedrive-library:' || id::text FROM affected_libraries
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  FOR candidate IN
    WITH changed AS (
      SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value
    )
    SELECT DISTINCT settings.id, settings.feature_link_id, settings.org_id
    FROM public.config_policy_onedrive_settings settings
    JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
    JOIN changed ON (
      TG_TABLE_NAME = 'config_policy_feature_links' AND changed.id = link.id
    ) OR (
      TG_TABLE_NAME = 'configuration_policies' AND changed.id = link.config_policy_id
    )
    ORDER BY settings.id
  LOOP
    PERFORM public.breeze_validate_config_policy_onedrive_settings(
      candidate.feature_link_id, candidate.org_id
    );
  END LOOP;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;

-- Replace all row-at-a-time OneDrive integrity triggers.
DROP TRIGGER IF EXISTS config_policy_onedrive_settings_tenant_integrity
  ON public.config_policy_onedrive_settings;
DROP TRIGGER IF EXISTS config_policy_onedrive_libraries_settings_owner_update
  ON public.config_policy_onedrive_settings;
DROP TRIGGER IF EXISTS a_onedrive_settings_insert ON public.config_policy_onedrive_settings;
CREATE TRIGGER a_onedrive_settings_insert AFTER INSERT ON public.config_policy_onedrive_settings
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_onedrive_settings_statements();
DROP TRIGGER IF EXISTS a_onedrive_settings_update ON public.config_policy_onedrive_settings;
CREATE TRIGGER a_onedrive_settings_update AFTER UPDATE ON public.config_policy_onedrive_settings
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_onedrive_settings_statements();
DROP TRIGGER IF EXISTS a_onedrive_settings_delete ON public.config_policy_onedrive_settings;
CREATE TRIGGER a_onedrive_settings_delete AFTER DELETE ON public.config_policy_onedrive_settings
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_onedrive_settings_statements();

DROP TRIGGER IF EXISTS config_policy_onedrive_libraries_tenant_integrity
  ON public.config_policy_onedrive_libraries;
DROP TRIGGER IF EXISTS a_onedrive_library_insert ON public.config_policy_onedrive_libraries;
CREATE TRIGGER a_onedrive_library_insert AFTER INSERT ON public.config_policy_onedrive_libraries
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_onedrive_library_statements();
DROP TRIGGER IF EXISTS a_onedrive_library_update ON public.config_policy_onedrive_libraries;
CREATE TRIGGER a_onedrive_library_update AFTER UPDATE ON public.config_policy_onedrive_libraries
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_onedrive_library_statements();
DROP TRIGGER IF EXISTS a_onedrive_library_delete ON public.config_policy_onedrive_libraries;
CREATE TRIGGER a_onedrive_library_delete AFTER DELETE ON public.config_policy_onedrive_libraries
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_onedrive_library_statements();

DROP TRIGGER IF EXISTS config_policy_onedrive_settings_link_reference_update
  ON public.config_policy_feature_links;
DROP TRIGGER IF EXISTS a_onedrive_reference_link_update ON public.config_policy_feature_links;
CREATE TRIGGER a_onedrive_reference_link_update AFTER UPDATE ON public.config_policy_feature_links
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_onedrive_parent_statements();
DROP TRIGGER IF EXISTS a_onedrive_reference_link_delete ON public.config_policy_feature_links;
CREATE TRIGGER a_onedrive_reference_link_delete AFTER DELETE ON public.config_policy_feature_links
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_onedrive_parent_statements();

DROP TRIGGER IF EXISTS config_policy_onedrive_settings_policy_owner_update
  ON public.configuration_policies;
DROP TRIGGER IF EXISTS a_onedrive_reference_policy_update ON public.configuration_policies;
CREATE TRIGGER a_onedrive_reference_policy_update AFTER UPDATE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_onedrive_parent_statements();
DROP TRIGGER IF EXISTS a_onedrive_reference_policy_delete ON public.configuration_policies;
CREATE TRIGGER a_onedrive_reference_policy_delete AFTER DELETE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_onedrive_parent_statements();

REVOKE ALL ON FUNCTION public.breeze_enforce_onedrive_settings_statements() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_onedrive_library_statements() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_onedrive_parent_statements() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_enforce_onedrive_settings_statements() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_onedrive_library_statements() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_onedrive_parent_statements() FROM breeze_app;
  END IF;
END;
$$;
