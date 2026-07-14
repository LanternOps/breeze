-- Bind normalized OneDrive rows to the org-owned configuration policy they
-- belong to. Run the forensic preflight in an explicit system context so a
-- non-superuser migration owner remains exhaustive under FORCE RLS.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  settings_mismatches integer;
  library_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO settings_mismatches
  FROM public.config_policy_onedrive_settings settings
  LEFT JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
  LEFT JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  WHERE link.id IS NULL
     OR link.feature_type <> 'onedrive_helper'
     OR policy.id IS NULL
     OR policy.partner_id IS NOT NULL
     OR settings.org_id IS DISTINCT FROM policy.org_id;

  SELECT COUNT(*) INTO library_mismatches
  FROM public.config_policy_onedrive_libraries library
  LEFT JOIN public.config_policy_onedrive_settings settings ON settings.id = library.settings_id
  WHERE settings.id IS NULL
     OR library.org_id IS DISTINCT FROM settings.org_id;

  IF settings_mismatches > 0 THEN
    RAISE WARNING 'config_policy_onedrive_settings owner/parent preflight found % mismatched row(s)', settings_mismatches;
  END IF;
  IF library_mismatches > 0 THEN
    RAISE WARNING 'config_policy_onedrive_libraries owner/parent preflight found % mismatched row(s)', library_mismatches;
  END IF;
  IF settings_mismatches + library_mismatches > 0 THEN
    RAISE EXCEPTION 'OneDrive configuration tenant-integrity preflight failed; no rows were changed'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_validate_config_policy_onedrive_settings(
  checked_feature_link_id uuid,
  checked_org_id uuid
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
BEGIN
  SELECT policy.org_id, policy.partner_id, link.feature_type::text
  INTO parent_org_id, parent_partner_id, parent_feature_type
  FROM public.config_policy_feature_links link
  JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  WHERE link.id = checked_feature_link_id;

  IF NOT FOUND
     OR parent_feature_type <> 'onedrive_helper'
     OR parent_partner_id IS NOT NULL
     OR checked_org_id IS DISTINCT FROM parent_org_id THEN
    RAISE EXCEPTION 'OneDrive settings owner must match an org-owned OneDrive policy'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_onedrive_settings_owner_match';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_validate_config_policy_onedrive_library(
  checked_settings_id uuid,
  checked_org_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.config_policy_onedrive_settings settings
    WHERE settings.id = checked_settings_id
      AND settings.org_id = checked_org_id
  ) THEN
    RAISE EXCEPTION 'OneDrive library owner must match its settings owner'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_onedrive_libraries_owner_match';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_onedrive_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.breeze_validate_config_policy_onedrive_settings(NEW.feature_link_id, NEW.org_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_onedrive_library()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.breeze_validate_config_policy_onedrive_library(NEW.settings_id, NEW.org_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_onedrive_settings_tenant_integrity
  ON public.config_policy_onedrive_settings;
CREATE TRIGGER config_policy_onedrive_settings_tenant_integrity
BEFORE INSERT OR UPDATE OF feature_link_id, org_id
ON public.config_policy_onedrive_settings
FOR EACH ROW EXECUTE FUNCTION public.breeze_enforce_config_policy_onedrive_settings();

DROP TRIGGER IF EXISTS config_policy_onedrive_libraries_tenant_integrity
  ON public.config_policy_onedrive_libraries;
CREATE TRIGGER config_policy_onedrive_libraries_tenant_integrity
BEFORE INSERT OR UPDATE OF settings_id, org_id
ON public.config_policy_onedrive_libraries
FOR EACH ROW EXECUTE FUNCTION public.breeze_enforce_config_policy_onedrive_library();

CREATE OR REPLACE FUNCTION public.breeze_revalidate_config_policy_onedrive_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_data record;
BEGIN
  IF TG_TABLE_NAME = 'config_policy_feature_links' THEN
    FOR row_data IN
      SELECT settings.feature_link_id, settings.org_id
      FROM public.config_policy_onedrive_settings settings
      WHERE settings.feature_link_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_onedrive_settings(
        row_data.feature_link_id, row_data.org_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'configuration_policies' THEN
    FOR row_data IN
      SELECT settings.feature_link_id, settings.org_id
      FROM public.config_policy_onedrive_settings settings
      JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
      WHERE link.config_policy_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_onedrive_settings(
        row_data.feature_link_id, row_data.org_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'config_policy_onedrive_settings' THEN
    FOR row_data IN
      SELECT library.settings_id, library.org_id
      FROM public.config_policy_onedrive_libraries library
      WHERE library.settings_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_onedrive_library(
        row_data.settings_id, row_data.org_id
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_onedrive_settings_link_reference_update
  ON public.config_policy_feature_links;
CREATE TRIGGER config_policy_onedrive_settings_link_reference_update
AFTER UPDATE OF config_policy_id, feature_type ON public.config_policy_feature_links
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_onedrive_reference();

DROP TRIGGER IF EXISTS config_policy_onedrive_settings_policy_owner_update
  ON public.configuration_policies;
CREATE TRIGGER config_policy_onedrive_settings_policy_owner_update
AFTER UPDATE OF org_id, partner_id ON public.configuration_policies
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_onedrive_reference();

DROP TRIGGER IF EXISTS config_policy_onedrive_libraries_settings_owner_update
  ON public.config_policy_onedrive_settings;
CREATE TRIGGER config_policy_onedrive_libraries_settings_owner_update
AFTER UPDATE OF org_id ON public.config_policy_onedrive_settings
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_onedrive_reference();

REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_onedrive_settings(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_onedrive_library(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_onedrive_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_onedrive_library() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_onedrive_reference() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_onedrive_settings(uuid,uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_onedrive_library(uuid,uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_onedrive_settings() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_onedrive_library() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_onedrive_reference() FROM breeze_app;
  END IF;
END $$;
