-- Keep the polymorphic backup feature reference and its normalized settings
-- representation in lockstep. Runtime resolution is profile-first: a UUID
-- present in backup_profiles is a profile even if the same UUID also exists in
-- backup_configs; otherwise a backup_configs UUID is the legacy destination.

-- FORCE RLS must not hide another tenant's corrupt row from the preflight.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  mismatch_count integer;
BEGIN
  SELECT COUNT(*) INTO mismatch_count
  FROM public.config_policy_feature_links link
  LEFT JOIN public.config_policy_backup_settings settings
    ON settings.feature_link_id = link.id
  LEFT JOIN public.backup_profiles profile
    ON profile.id = link.feature_policy_id
  LEFT JOIN public.backup_configs legacy_destination
    ON legacy_destination.id = link.feature_policy_id
  WHERE link.feature_type = 'backup'
    AND (
      (link.feature_policy_id IS NULL
        AND settings.id IS NOT NULL
        AND settings.backup_profile_id IS NOT NULL)
      OR (link.feature_policy_id IS NOT NULL AND profile.id IS NOT NULL AND (
        settings.id IS NULL
        OR settings.backup_profile_id IS DISTINCT FROM link.feature_policy_id
      ))
      OR (link.feature_policy_id IS NOT NULL AND profile.id IS NULL
        AND legacy_destination.id IS NOT NULL
        AND settings.id IS NOT NULL
        AND (
          settings.backup_profile_id IS NOT NULL
          OR settings.destination_config_id IS DISTINCT FROM link.feature_policy_id
        ))
      OR (link.feature_policy_id IS NOT NULL
        AND profile.id IS NULL
        AND legacy_destination.id IS NULL)
    );

  IF mismatch_count > 0 THEN
    RAISE WARNING 'backup feature/settings parity preflight found % mismatched row(s)', mismatch_count;
    RAISE EXCEPTION 'backup feature/settings parity preflight failed; no rows were changed'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_backup_feature_settings_parity_is_valid(
  checked_feature_link_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET "breeze.scope" = 'system'
AS $$
DECLARE
  checked_feature_type public.config_feature_type;
  checked_feature_policy_id uuid;
  settings_exists boolean;
  normalized_profile_id uuid;
  normalized_destination_id uuid;
  profile_exists boolean;
  legacy_destination_exists boolean;
BEGIN
  SELECT link.feature_type, link.feature_policy_id
    INTO checked_feature_type, checked_feature_policy_id
  FROM public.config_policy_feature_links link
  WHERE link.id = checked_feature_link_id;

  -- A deleted link has no remaining parity obligation. Its settings row is
  -- removed by ON DELETE CASCADE in the same transaction.
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  IF checked_feature_type <> 'backup' THEN
    RETURN true;
  END IF;

  SELECT settings.backup_profile_id, settings.destination_config_id
    INTO normalized_profile_id, normalized_destination_id
  FROM public.config_policy_backup_settings settings
  WHERE settings.feature_link_id = checked_feature_link_id;
  settings_exists := FOUND;

  IF checked_feature_policy_id IS NULL THEN
    RETURN NOT settings_exists OR normalized_profile_id IS NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.backup_profiles profile
    WHERE profile.id = checked_feature_policy_id
  ) INTO profile_exists;

  IF profile_exists THEN
    RETURN settings_exists
      AND normalized_profile_id IS NOT DISTINCT FROM checked_feature_policy_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.backup_configs destination
    WHERE destination.id = checked_feature_policy_id
  ) INTO legacy_destination_exists;

  IF legacy_destination_exists THEN
    -- A missing row remains valid for legacy links: runtime resolution still
    -- supports the historical feature-policy destination fallback.
    RETURN NOT settings_exists OR (
      normalized_profile_id IS NULL
      AND normalized_destination_id IS NOT DISTINCT FROM checked_feature_policy_id
    );
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_backup_feature_settings_parity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET "breeze.scope" = 'system'
AS $$
DECLARE
  old_link_id uuid;
  new_link_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'config_policy_feature_links' THEN
    IF TG_OP <> 'INSERT' THEN
      old_link_id := OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_link_id := NEW.id;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      old_link_id := OLD.feature_link_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_link_id := NEW.feature_link_id;
    END IF;
  END IF;

  IF old_link_id IS NOT NULL
    AND NOT public.breeze_backup_feature_settings_parity_is_valid(old_link_id)
  THEN
    RAISE EXCEPTION 'backup feature link % and normalized settings are inconsistent', old_link_id
      USING ERRCODE = '23514';
  END IF;

  IF new_link_id IS NOT NULL
    AND new_link_id IS DISTINCT FROM old_link_id
    AND NOT public.breeze_backup_feature_settings_parity_is_valid(new_link_id)
  THEN
    RAISE EXCEPTION 'backup feature link % and normalized settings are inconsistent', new_link_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_feature_links_backup_settings_parity
  ON public.config_policy_feature_links;
CREATE CONSTRAINT TRIGGER config_policy_feature_links_backup_settings_parity
AFTER INSERT OR UPDATE OR DELETE ON public.config_policy_feature_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.breeze_enforce_backup_feature_settings_parity();

DROP TRIGGER IF EXISTS config_policy_backup_settings_feature_parity
  ON public.config_policy_backup_settings;
CREATE CONSTRAINT TRIGGER config_policy_backup_settings_feature_parity
AFTER INSERT OR UPDATE OR DELETE ON public.config_policy_backup_settings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.breeze_enforce_backup_feature_settings_parity();

REVOKE ALL ON FUNCTION public.breeze_backup_feature_settings_parity_is_valid(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_backup_feature_settings_parity() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_backup_feature_settings_parity_is_valid(uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_backup_feature_settings_parity() FROM breeze_app;
  END IF;
END $$;
