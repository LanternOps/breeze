-- Fix-forward tenant integrity for normalized configuration-policy children.
-- Abort rather than repair owner mismatches: any existing mismatch can be
-- evidence of a cross-tenant write and must remain available for investigation.

DO $$
DECLARE
  parent_mismatches integer;
  profile_mismatches integer;
  destination_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO parent_mismatches
  FROM config_policy_backup_settings settings
  LEFT JOIN config_policy_feature_links link ON link.id = settings.feature_link_id
  LEFT JOIN configuration_policies policy ON policy.id = link.config_policy_id
  WHERE link.id IS NULL
     OR link.feature_type <> 'backup'
     OR policy.id IS NULL
     OR settings.org_id IS DISTINCT FROM policy.org_id
     OR settings.partner_id IS DISTINCT FROM policy.partner_id;

  SELECT COUNT(*) INTO profile_mismatches
  FROM config_policy_backup_settings settings
  JOIN config_policy_feature_links link ON link.id = settings.feature_link_id
  JOIN configuration_policies policy ON policy.id = link.config_policy_id
  LEFT JOIN organizations policy_org ON policy_org.id = policy.org_id
  LEFT JOIN backup_profiles profile ON profile.id = settings.backup_profile_id
  WHERE settings.backup_profile_id IS NOT NULL
    AND NOT (
      profile.id IS NOT NULL
      AND (
        (policy.org_id IS NOT NULL AND (
          (profile.org_id = policy.org_id AND profile.partner_id IS NULL)
          OR (profile.org_id IS NULL AND profile.partner_id = policy_org.partner_id)
        ))
        OR (policy.partner_id IS NOT NULL
          AND profile.org_id IS NULL
          AND profile.partner_id = policy.partner_id)
      )
    );

  SELECT COUNT(*) INTO destination_mismatches
  FROM config_policy_backup_settings settings
  JOIN config_policy_feature_links link ON link.id = settings.feature_link_id
  JOIN configuration_policies policy ON policy.id = link.config_policy_id
  LEFT JOIN backup_configs destination ON destination.id = settings.destination_config_id
  WHERE settings.destination_config_id IS NOT NULL
    AND NOT (
      policy.org_id IS NOT NULL
      AND destination.id IS NOT NULL
      AND destination.org_id = policy.org_id
    );

  IF parent_mismatches > 0 THEN
    RAISE WARNING 'config_policy_backup_settings owner/parent preflight found % mismatched row(s)', parent_mismatches;
  END IF;
  IF profile_mismatches > 0 THEN
    RAISE WARNING 'config_policy_backup_settings profile preflight found % mismatched row(s)', profile_mismatches;
  END IF;
  IF destination_mismatches > 0 THEN
    RAISE WARNING 'config_policy_backup_settings destination preflight found % mismatched row(s)', destination_mismatches;
  END IF;
  IF parent_mismatches + profile_mismatches + destination_mismatches > 0 THEN
    RAISE EXCEPTION 'normalized backup tenant-integrity preflight failed; no rows were changed'
      USING ERRCODE = '23514';
  END IF;
END $$;

-- The feature-link and assignment parents are themselves tenant children of
-- configuration_policies. They are exported directly and must not rely on the
-- table owner's implicit RLS bypass, so replace the legacy ALL policies with
-- command-complete forced policies as well.
DO $$
DECLARE
  table_name text;
  legacy_policy text;
  predicate text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'config_policy_feature_links',
    'config_policy_assignments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    legacy_policy := table_name || '_org_isolation';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', legacy_policy, table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I', table_name);

    predicate := format(
      'EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = %I.config_policy_id '
      || 'AND (breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))',
      table_name
    );
    EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)', table_name, predicate);
    EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)', table_name, predicate);
    EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', table_name, predicate, predicate);
    EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)', table_name, predicate);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION breeze_validate_config_policy_backup_settings(
  checked_feature_link_id uuid,
  checked_org_id uuid,
  checked_partner_id uuid,
  checked_backup_profile_id uuid,
  checked_destination_config_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
  parent_feature_type text;
  parent_org_partner_id uuid;
BEGIN
  SELECT policy.org_id, policy.partner_id, link.feature_type::text, org.partner_id
  INTO parent_org_id, parent_partner_id, parent_feature_type, parent_org_partner_id
  FROM public.config_policy_feature_links link
  JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  LEFT JOIN public.organizations org ON org.id = policy.org_id
  WHERE link.id = checked_feature_link_id;

  IF NOT FOUND OR parent_feature_type <> 'backup' THEN
    RAISE EXCEPTION 'backup settings feature link must resolve to a backup policy'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_backup_settings_parent_fk';
  END IF;
  IF checked_org_id IS DISTINCT FROM parent_org_id
     OR checked_partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'backup settings owner must match its parent policy owner'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_backup_settings_owner_match';
  END IF;

  IF checked_backup_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.backup_profiles profile
    WHERE profile.id = checked_backup_profile_id
      AND (
        (parent_org_id IS NOT NULL AND (
          (profile.org_id = parent_org_id AND profile.partner_id IS NULL)
          OR (profile.org_id IS NULL AND profile.partner_id = parent_org_partner_id)
        ))
        OR (parent_partner_id IS NOT NULL
          AND profile.org_id IS NULL
          AND profile.partner_id = parent_partner_id)
      )
  ) THEN
    RAISE EXCEPTION 'backup profile owner is incompatible with the parent policy owner'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_backup_settings_profile_owner_fk';
  END IF;

  IF checked_destination_config_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.backup_configs destination
    WHERE destination.id = checked_destination_config_id
      AND parent_org_id IS NOT NULL
      AND destination.org_id = parent_org_id
  ) THEN
    RAISE EXCEPTION 'backup destination must belong to the org-owned parent policy'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_backup_settings_destination_owner_fk';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION breeze_enforce_config_policy_backup_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Preserve the table's established XOR constraint/error contract. Tenant
  -- reference validation only applies once exactly one ownership axis exists.
  IF (NEW.org_id IS NULL) = (NEW.partner_id IS NULL) THEN
    RETURN NEW;
  END IF;
  PERFORM public.breeze_validate_config_policy_backup_settings(
    NEW.feature_link_id, NEW.org_id, NEW.partner_id,
    NEW.backup_profile_id, NEW.destination_config_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_backup_settings_tenant_integrity
  ON config_policy_backup_settings;
CREATE TRIGGER config_policy_backup_settings_tenant_integrity
BEFORE INSERT OR UPDATE OF feature_link_id, org_id, partner_id, backup_profile_id, destination_config_id
ON config_policy_backup_settings
FOR EACH ROW EXECUTE FUNCTION breeze_enforce_config_policy_backup_settings();

CREATE OR REPLACE FUNCTION breeze_revalidate_config_policy_backup_settings_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE settings record;
BEGIN
  IF TG_TABLE_NAME = 'config_policy_feature_links' THEN
    FOR settings IN
      SELECT child.* FROM public.config_policy_backup_settings child
      WHERE child.feature_link_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_backup_settings(
        settings.feature_link_id, settings.org_id, settings.partner_id,
        settings.backup_profile_id, settings.destination_config_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'configuration_policies' THEN
    FOR settings IN
      SELECT child.* FROM public.config_policy_backup_settings child
      JOIN public.config_policy_feature_links link ON link.id = child.feature_link_id
      WHERE link.config_policy_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_backup_settings(
        settings.feature_link_id, settings.org_id, settings.partner_id,
        settings.backup_profile_id, settings.destination_config_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'backup_profiles' THEN
    FOR settings IN
      SELECT child.* FROM public.config_policy_backup_settings child
      WHERE child.backup_profile_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_backup_settings(
        settings.feature_link_id, settings.org_id, settings.partner_id,
        settings.backup_profile_id, settings.destination_config_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'backup_configs' THEN
    FOR settings IN
      SELECT child.* FROM public.config_policy_backup_settings child
      WHERE child.destination_config_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_backup_settings(
        settings.feature_link_id, settings.org_id, settings.partner_id,
        settings.backup_profile_id, settings.destination_config_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    FOR settings IN
      SELECT child.* FROM public.config_policy_backup_settings child
      JOIN public.config_policy_feature_links link ON link.id = child.feature_link_id
      JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
      WHERE policy.org_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_backup_settings(
        settings.feature_link_id, settings.org_id, settings.partner_id,
        settings.backup_profile_id, settings.destination_config_id
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_backup_settings_link_reference_update ON config_policy_feature_links;
CREATE TRIGGER config_policy_backup_settings_link_reference_update
AFTER UPDATE OF config_policy_id, feature_type ON config_policy_feature_links
FOR EACH ROW EXECUTE FUNCTION breeze_revalidate_config_policy_backup_settings_reference();

DROP TRIGGER IF EXISTS config_policy_backup_settings_policy_owner_update ON configuration_policies;
CREATE TRIGGER config_policy_backup_settings_policy_owner_update
AFTER UPDATE OF org_id, partner_id ON configuration_policies
FOR EACH ROW EXECUTE FUNCTION breeze_revalidate_config_policy_backup_settings_reference();

DROP TRIGGER IF EXISTS config_policy_backup_settings_profile_owner_update ON backup_profiles;
CREATE TRIGGER config_policy_backup_settings_profile_owner_update
AFTER UPDATE OF org_id, partner_id ON backup_profiles
FOR EACH ROW EXECUTE FUNCTION breeze_revalidate_config_policy_backup_settings_reference();

DROP TRIGGER IF EXISTS config_policy_backup_settings_destination_owner_update ON backup_configs;
CREATE TRIGGER config_policy_backup_settings_destination_owner_update
AFTER UPDATE OF org_id ON backup_configs
FOR EACH ROW EXECUTE FUNCTION breeze_revalidate_config_policy_backup_settings_reference();

DROP TRIGGER IF EXISTS config_policy_backup_settings_org_partner_update ON organizations;
CREATE TRIGGER config_policy_backup_settings_org_partner_update
AFTER UPDATE OF partner_id ON organizations
FOR EACH ROW EXECUTE FUNCTION breeze_revalidate_config_policy_backup_settings_reference();

REVOKE ALL ON FUNCTION breeze_validate_config_policy_backup_settings(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION breeze_enforce_config_policy_backup_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION breeze_revalidate_config_policy_backup_settings_reference() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION breeze_validate_config_policy_backup_settings(uuid,uuid,uuid,uuid,uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION breeze_enforce_config_policy_backup_settings() FROM breeze_app;
    REVOKE ALL ON FUNCTION breeze_revalidate_config_policy_backup_settings_reference() FROM breeze_app;
  END IF;
END $$;

DO $$
DECLARE
  table_name text;
  legacy_policy text;
  predicate text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'config_policy_alert_rules',
    'config_policy_automations',
    'config_policy_compliance_rules',
    'config_policy_patch_settings',
    'config_policy_maintenance_settings',
    'config_policy_event_log_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    legacy_policy := table_name || '_org_isolation';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', legacy_policy, table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I', table_name);

    predicate := format(
      'EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = '
      || '(SELECT link.config_policy_id FROM config_policy_feature_links link '
      || 'WHERE link.id = %I.feature_link_id) AND '
      || '(breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))',
      table_name
    );
    EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)', table_name, predicate);
    EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)', table_name, predicate);
    EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', table_name, predicate, predicate);
    EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)', table_name, predicate);
  END LOOP;
END $$;
