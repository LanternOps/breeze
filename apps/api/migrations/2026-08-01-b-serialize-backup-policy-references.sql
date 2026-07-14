-- Serialize normalized backup settings with their feature link, parent owner,
-- profile, destination, and organization relationships.  This reuses the
-- dedicated feature/reference namespace introduced by 08-01-a.

CREATE OR REPLACE FUNCTION public.breeze_enforce_backup_settings_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  row_values jsonb[] := ARRAY[]::jsonb[];
  new_values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
  candidate record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'config_policy_backup_settings' THEN
    RAISE EXCEPTION 'unsupported backup settings serializer table: %.%',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
    new_values := row_values;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT EXISTS (
      (SELECT id, feature_link_id, org_id, partner_id, backup_profile_id, destination_config_id
       FROM old_rows
       EXCEPT
       SELECT id, feature_link_id, org_id, partner_id, backup_profile_id, destination_config_id
       FROM new_rows)
      UNION ALL
      (SELECT id, feature_link_id, org_id, partner_id, backup_profile_id, destination_config_id
       FROM new_rows
       EXCEPT
       SELECT id, feature_link_id, org_id, partner_id, backup_profile_id, destination_config_id
       FROM old_rows)
    ) THEN
      RETURN NULL;
    END IF;
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO new_values FROM new_rows row;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values
    FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL SELECT value FROM unnest(new_values) value
    ) rows;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  PERFORM link.id
  FROM public.config_policy_feature_links link
  JOIN (SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
        FROM unnest(row_values) value) requested ON requested.id = link.id
  ORDER BY link.id FOR KEY SHARE OF link;

  PERFORM policy.id
  FROM public.configuration_policies policy
  JOIN public.config_policy_feature_links link ON link.config_policy_id = policy.id
  JOIN (SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
        FROM unnest(row_values) value) requested ON requested.id = link.id
  ORDER BY policy.id FOR KEY SHARE OF policy;

  PERFORM org.id
  FROM public.organizations org
  JOIN (
    SELECT (value->>'org_id')::uuid AS id
    FROM unnest(row_values) value WHERE value->>'org_id' IS NOT NULL
    UNION
    SELECT policy.org_id
    FROM public.configuration_policies policy
    JOIN public.config_policy_feature_links link ON link.config_policy_id = policy.id
    JOIN (SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
          FROM unnest(row_values) value) requested ON requested.id = link.id
    WHERE policy.org_id IS NOT NULL
  ) requested ON requested.id = org.id
  ORDER BY org.id FOR KEY SHARE OF org;

  -- Every UUID participating in backup resolution locks both candidates.
  PERFORM profile.id
  FROM public.backup_profiles profile
  JOIN (
    SELECT (value->>'backup_profile_id')::uuid AS id FROM unnest(row_values) value
      WHERE value->>'backup_profile_id' IS NOT NULL
    UNION SELECT (value->>'destination_config_id')::uuid FROM unnest(row_values) value
      WHERE value->>'destination_config_id' IS NOT NULL
    UNION SELECT link.feature_policy_id
      FROM public.config_policy_feature_links link
      JOIN (SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
            FROM unnest(row_values) value) requested ON requested.id = link.id
      WHERE link.feature_type = 'backup' AND link.feature_policy_id IS NOT NULL
  ) requested ON requested.id = profile.id
  ORDER BY profile.id FOR KEY SHARE OF profile;

  PERFORM destination.id
  FROM public.backup_configs destination
  JOIN (
    SELECT (value->>'backup_profile_id')::uuid AS id FROM unnest(row_values) value
      WHERE value->>'backup_profile_id' IS NOT NULL
    UNION SELECT (value->>'destination_config_id')::uuid FROM unnest(row_values) value
      WHERE value->>'destination_config_id' IS NOT NULL
    UNION SELECT link.feature_policy_id
      FROM public.config_policy_feature_links link
      JOIN (SELECT DISTINCT (value->>'feature_link_id')::uuid AS id
            FROM unnest(row_values) value) requested ON requested.id = link.id
      WHERE link.feature_type = 'backup' AND link.feature_policy_id IS NOT NULL
  ) requested ON requested.id = destination.id
  ORDER BY destination.id FOR KEY SHARE OF destination;

  FOR lock_key IN
    WITH setting_rows AS (
      SELECT (value->>'id')::uuid AS id,
        (value->>'feature_link_id')::uuid AS feature_link_id,
        (value->>'org_id')::uuid AS org_id,
        (value->>'partner_id')::uuid AS partner_id,
        (value->>'backup_profile_id')::uuid AS profile_id,
        (value->>'destination_config_id')::uuid AS destination_id
      FROM unnest(row_values) value
    ), links AS (
      SELECT link.id, link.config_policy_id, link.feature_policy_id
      FROM public.config_policy_feature_links link
      JOIN (SELECT DISTINCT feature_link_id AS id FROM setting_rows) requested
        ON requested.id = link.id
    ), owners AS (
      SELECT policy.id, policy.org_id,
        COALESCE(policy.partner_id, org.partner_id) AS partner_id
      FROM public.configuration_policies policy
      LEFT JOIN public.organizations org ON org.id = policy.org_id
      JOIN links ON links.config_policy_id = policy.id
    ), reference_ids AS (
      SELECT profile_id AS id FROM setting_rows WHERE profile_id IS NOT NULL
      UNION SELECT destination_id FROM setting_rows WHERE destination_id IS NOT NULL
      UNION SELECT feature_policy_id FROM links WHERE feature_policy_id IS NOT NULL
    ), identities AS (
      SELECT 'backup-settings:' || id::text AS identity FROM setting_rows
      UNION SELECT 'feature-link:' || feature_link_id::text FROM setting_rows
      UNION SELECT 'policy:' || config_policy_id::text FROM links
      UNION SELECT 'org:' || org_id::text FROM setting_rows WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM setting_rows WHERE partner_id IS NOT NULL
      UNION SELECT 'org:' || org_id::text FROM owners WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM owners WHERE partner_id IS NOT NULL
      UNION SELECT 'ref:backup_profiles:' || id::text FROM reference_ids
      UNION SELECT 'ref:backup_configs:' || id::text FROM reference_ids
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  IF TG_OP <> 'DELETE' THEN
    FOR candidate IN
      SELECT settings.*
      FROM public.config_policy_backup_settings settings
      JOIN (SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(new_values) value)
        changed ON changed.id = settings.id
      ORDER BY settings.id
    LOOP
      PERFORM public.breeze_validate_config_policy_backup_settings(
        candidate.feature_link_id, candidate.org_id, candidate.partner_id,
        candidate.backup_profile_id, candidate.destination_config_id
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_revalidate_backup_refs_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  row_values jsonb[] := ARRAY[]::jsonb[];
  changed_values boolean := true;
  lock_key integer;
  candidate record;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME NOT IN (
    'config_policy_feature_links', 'configuration_policies', 'backup_profiles',
    'backup_configs', 'organizations'
  ) THEN
    RAISE EXCEPTION 'unsupported backup reference reverse table: %.%',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      (SELECT CASE TG_TABLE_NAME
        WHEN 'config_policy_feature_links' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'config_policy_id',
          to_jsonb(row)->'feature_type', to_jsonb(row)->'feature_policy_id')
        WHEN 'configuration_policies' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_profiles' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_configs' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id')
        ELSE jsonb_build_array(to_jsonb(row)->'id', to_jsonb(row)->'partner_id')
      END FROM old_rows row
      EXCEPT
      SELECT CASE TG_TABLE_NAME
        WHEN 'config_policy_feature_links' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'config_policy_id',
          to_jsonb(row)->'feature_type', to_jsonb(row)->'feature_policy_id')
        WHEN 'configuration_policies' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_profiles' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_configs' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id')
        ELSE jsonb_build_array(to_jsonb(row)->'id', to_jsonb(row)->'partner_id')
      END FROM new_rows row)
      UNION ALL
      (SELECT CASE TG_TABLE_NAME
        WHEN 'config_policy_feature_links' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'config_policy_id',
          to_jsonb(row)->'feature_type', to_jsonb(row)->'feature_policy_id')
        WHEN 'configuration_policies' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_profiles' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_configs' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id')
        ELSE jsonb_build_array(to_jsonb(row)->'id', to_jsonb(row)->'partner_id')
      END FROM new_rows row
      EXCEPT
      SELECT CASE TG_TABLE_NAME
        WHEN 'config_policy_feature_links' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'config_policy_id',
          to_jsonb(row)->'feature_type', to_jsonb(row)->'feature_policy_id')
        WHEN 'configuration_policies' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_profiles' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id', to_jsonb(row)->'partner_id')
        WHEN 'backup_configs' THEN jsonb_build_array(
          to_jsonb(row)->'id', to_jsonb(row)->'org_id')
        ELSE jsonb_build_array(to_jsonb(row)->'id', to_jsonb(row)->'partner_id')
      END FROM old_rows row)
    ) INTO changed_values;
    IF NOT changed_values THEN RETURN NULL; END IF;
    SELECT COALESCE(array_agg(value), ARRAY[]::jsonb[]) INTO row_values FROM (
      SELECT to_jsonb(row) AS value FROM old_rows row
      UNION ALL SELECT to_jsonb(row) AS value FROM new_rows row
    ) rows;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM old_rows row;
  END IF;

  -- Stabilize currently-visible normalized rows.  Uncommitted rows overlap on
  -- the transition-derived link/policy/ref/org key acquired below.
  IF TG_TABLE_NAME = 'config_policy_feature_links' THEN
    PERFORM settings.id FROM public.config_policy_backup_settings settings
    JOIN (SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value)
      changed ON changed.id = settings.feature_link_id
    ORDER BY settings.id FOR KEY SHARE OF settings;
  ELSIF TG_TABLE_NAME = 'configuration_policies' THEN
    PERFORM settings.id FROM public.config_policy_backup_settings settings
    JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
    JOIN (SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value)
      changed ON changed.id = link.config_policy_id
    ORDER BY settings.id FOR KEY SHARE OF settings;
  ELSIF TG_TABLE_NAME = 'backup_profiles' THEN
    PERFORM settings.id FROM public.config_policy_backup_settings settings
    JOIN (SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value)
      changed ON changed.id = settings.backup_profile_id
    ORDER BY settings.id FOR KEY SHARE OF settings;
  ELSIF TG_TABLE_NAME = 'backup_configs' THEN
    PERFORM settings.id FROM public.config_policy_backup_settings settings
    JOIN (SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value)
      changed ON changed.id = settings.destination_config_id
    ORDER BY settings.id FOR KEY SHARE OF settings;
  ELSE
    PERFORM settings.id FROM public.config_policy_backup_settings settings
    JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
    JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
    JOIN (SELECT DISTINCT (value->>'id')::uuid AS id FROM unnest(row_values) value)
      changed ON changed.id = policy.org_id
    ORDER BY settings.id FOR KEY SHARE OF settings;
  END IF;

  FOR lock_key IN
    WITH changed_rows AS (
      SELECT value FROM unnest(row_values) value
    ), affected_settings AS (
      SELECT settings.* FROM public.config_policy_backup_settings settings
      WHERE (TG_TABLE_NAME = 'config_policy_feature_links'
          AND settings.feature_link_id IN (SELECT (value->>'id')::uuid FROM changed_rows))
        OR (TG_TABLE_NAME = 'backup_profiles'
          AND settings.backup_profile_id IN (SELECT (value->>'id')::uuid FROM changed_rows))
        OR (TG_TABLE_NAME = 'backup_configs'
          AND settings.destination_config_id IN (SELECT (value->>'id')::uuid FROM changed_rows))
        OR (TG_TABLE_NAME = 'configuration_policies' AND EXISTS (
          SELECT 1 FROM public.config_policy_feature_links link
          WHERE link.id = settings.feature_link_id
            AND link.config_policy_id IN (SELECT (value->>'id')::uuid FROM changed_rows)))
        OR (TG_TABLE_NAME = 'organizations' AND EXISTS (
          SELECT 1 FROM public.config_policy_feature_links link
          JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
          WHERE link.id = settings.feature_link_id
            AND policy.org_id IN (SELECT (value->>'id')::uuid FROM changed_rows)))
    ), links AS (
      SELECT link.* FROM public.config_policy_feature_links link
      JOIN affected_settings settings ON settings.feature_link_id = link.id
    ), identities AS (
      SELECT 'backup-settings:' || id::text AS identity FROM affected_settings
      UNION SELECT 'feature-link:' || feature_link_id::text FROM affected_settings
      UNION SELECT 'policy:' || config_policy_id::text FROM links
      UNION SELECT 'org:' || org_id::text FROM affected_settings WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM affected_settings WHERE partner_id IS NOT NULL
      UNION SELECT 'ref:backup_profiles:' || backup_profile_id::text
        FROM affected_settings WHERE backup_profile_id IS NOT NULL
      UNION SELECT 'ref:backup_configs:' || backup_profile_id::text
        FROM affected_settings WHERE backup_profile_id IS NOT NULL
      UNION SELECT 'ref:backup_profiles:' || destination_config_id::text
        FROM affected_settings WHERE destination_config_id IS NOT NULL
      UNION SELECT 'ref:backup_configs:' || destination_config_id::text
        FROM affected_settings WHERE destination_config_id IS NOT NULL
      UNION SELECT CASE TG_TABLE_NAME
        WHEN 'config_policy_feature_links' THEN 'feature-link:' || (value->>'id')
        WHEN 'configuration_policies' THEN 'policy:' || (value->>'id')
        WHEN 'organizations' THEN 'org:' || (value->>'id')
        ELSE 'ref:backup_profiles:' || (value->>'id')
      END FROM changed_rows
      UNION SELECT CASE TG_TABLE_NAME
        WHEN 'backup_profiles' THEN 'ref:backup_configs:' || (value->>'id')
        WHEN 'backup_configs' THEN 'ref:backup_configs:' || (value->>'id')
        ELSE NULL
      END FROM changed_rows
    )
    SELECT DISTINCT hashtext(identity) FROM identities
    WHERE identity IS NOT NULL ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000302, lock_key);
  END LOOP;

  -- Re-query after serialization and validate every relationship affected by
  -- the changed physical owner or identity.
  FOR candidate IN
    SELECT settings.* FROM public.config_policy_backup_settings settings
    WHERE (TG_TABLE_NAME = 'config_policy_feature_links'
        AND settings.feature_link_id IN (
          SELECT (value->>'id')::uuid FROM unnest(row_values) value))
      OR (TG_TABLE_NAME = 'backup_profiles'
        AND settings.backup_profile_id IN (
          SELECT (value->>'id')::uuid FROM unnest(row_values) value))
      OR (TG_TABLE_NAME = 'backup_configs'
        AND settings.destination_config_id IN (
          SELECT (value->>'id')::uuid FROM unnest(row_values) value))
      OR (TG_TABLE_NAME = 'configuration_policies' AND EXISTS (
        SELECT 1 FROM public.config_policy_feature_links link
        WHERE link.id = settings.feature_link_id
          AND link.config_policy_id IN (
            SELECT (value->>'id')::uuid FROM unnest(row_values) value)))
      OR (TG_TABLE_NAME = 'organizations' AND EXISTS (
        SELECT 1 FROM public.config_policy_feature_links link
        JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
        WHERE link.id = settings.feature_link_id
          AND policy.org_id IN (
            SELECT (value->>'id')::uuid FROM unnest(row_values) value)))
    ORDER BY settings.id
  LOOP
    PERFORM public.breeze_validate_config_policy_backup_settings(
      candidate.feature_link_id, candidate.org_id, candidate.partner_id,
      candidate.backup_profile_id, candidate.destination_config_id
    );
  END LOOP;

  -- Link/settings parity remains transactionally deferred so callers may
  -- update both representations in either order.  Physical candidate changes
  -- are different: they can change profile-first polymorphic resolution
  -- without touching either deferred-trigger table, so recheck them here.
  IF TG_TABLE_NAME IN ('backup_profiles', 'backup_configs') THEN
    FOR candidate IN
      SELECT DISTINCT link.* FROM public.config_policy_feature_links link
      WHERE link.feature_type = 'backup'
        AND link.feature_policy_id IN (
          SELECT (value->>'id')::uuid FROM unnest(row_values) value)
      ORDER BY link.id
    LOOP
      PERFORM public.breeze_validate_config_policy_feature_reference(
        candidate.config_policy_id, candidate.feature_type, candidate.feature_policy_id
      );
      IF NOT public.breeze_backup_feature_settings_parity_is_valid(candidate.id) THEN
        RAISE EXCEPTION 'backup feature link and normalized settings are inconsistent'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

-- Replace normalized settings row validation with statement serialization.
DROP TRIGGER IF EXISTS config_policy_backup_settings_tenant_integrity
  ON public.config_policy_backup_settings;
DROP TRIGGER IF EXISTS aa_backup_settings_insert ON public.config_policy_backup_settings;
CREATE TRIGGER aa_backup_settings_insert AFTER INSERT ON public.config_policy_backup_settings
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_backup_settings_stmt();
DROP TRIGGER IF EXISTS aa_backup_settings_update ON public.config_policy_backup_settings;
CREATE TRIGGER aa_backup_settings_update AFTER UPDATE ON public.config_policy_backup_settings
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_backup_settings_stmt();
DROP TRIGGER IF EXISTS aa_backup_settings_delete ON public.config_policy_backup_settings;
CREATE TRIGGER aa_backup_settings_delete AFTER DELETE ON public.config_policy_backup_settings
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_backup_settings_stmt();

-- Replace 07-26 row reverse triggers.  Slice A remains the first serializer on
-- links, policies, and organizations; these `ab_` triggers revalidate the
-- normalized representation after the shared lock is held.
DROP TRIGGER IF EXISTS config_policy_backup_settings_link_reference_update ON public.config_policy_feature_links;
DROP TRIGGER IF EXISTS ab_backup_refs_link_update ON public.config_policy_feature_links;
CREATE TRIGGER ab_backup_refs_link_update AFTER UPDATE ON public.config_policy_feature_links
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();
DROP TRIGGER IF EXISTS ab_backup_refs_link_delete ON public.config_policy_feature_links;
CREATE TRIGGER ab_backup_refs_link_delete AFTER DELETE ON public.config_policy_feature_links
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();

DROP TRIGGER IF EXISTS config_policy_backup_settings_policy_owner_update ON public.configuration_policies;
DROP TRIGGER IF EXISTS ab_backup_refs_policy_update ON public.configuration_policies;
CREATE TRIGGER ab_backup_refs_policy_update AFTER UPDATE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();
DROP TRIGGER IF EXISTS ab_backup_refs_policy_delete ON public.configuration_policies;
CREATE TRIGGER ab_backup_refs_policy_delete AFTER DELETE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();

DROP TRIGGER IF EXISTS config_policy_backup_settings_org_partner_update ON public.organizations;
DROP TRIGGER IF EXISTS ab_backup_refs_org_update ON public.organizations;
CREATE TRIGGER ab_backup_refs_org_update AFTER UPDATE ON public.organizations
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();

-- Replace Slice A's backup target triggers so both candidate identities are
-- co-locked before feature and normalized-settings validation.
DROP TRIGGER IF EXISTS config_policy_backup_settings_profile_owner_update ON public.backup_profiles;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_profiles_insert ON public.backup_profiles;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_profiles_update ON public.backup_profiles;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_profiles_delete ON public.backup_profiles;
DROP TRIGGER IF EXISTS aa_backup_refs_profile_insert ON public.backup_profiles;
CREATE TRIGGER aa_backup_refs_profile_insert AFTER INSERT ON public.backup_profiles
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();
DROP TRIGGER IF EXISTS aa_backup_refs_profile_update ON public.backup_profiles;
CREATE TRIGGER aa_backup_refs_profile_update AFTER UPDATE ON public.backup_profiles
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();
DROP TRIGGER IF EXISTS aa_backup_refs_profile_delete ON public.backup_profiles;
CREATE TRIGGER aa_backup_refs_profile_delete AFTER DELETE ON public.backup_profiles
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();

DROP TRIGGER IF EXISTS config_policy_backup_settings_destination_owner_update ON public.backup_configs;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_configs_update ON public.backup_configs;
DROP TRIGGER IF EXISTS aa_config_policy_feature_ref_backup_configs_delete ON public.backup_configs;
DROP TRIGGER IF EXISTS aa_backup_refs_config_update ON public.backup_configs;
CREATE TRIGGER aa_backup_refs_config_update AFTER UPDATE ON public.backup_configs
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();
DROP TRIGGER IF EXISTS aa_backup_refs_config_delete ON public.backup_configs;
CREATE TRIGGER aa_backup_refs_config_delete AFTER DELETE ON public.backup_configs
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_revalidate_backup_refs_stmt();

REVOKE ALL ON FUNCTION public.breeze_enforce_backup_settings_stmt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_backup_refs_stmt() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_enforce_backup_settings_stmt() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_backup_refs_stmt() FROM breeze_app;
  END IF;
END $$;
