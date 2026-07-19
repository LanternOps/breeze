-- Tenant-bind every polymorphic feature_policy_id reference to its declared
-- feature type and the ownership axis of its configuration-policy parent.
-- Backup links resolve with profile precedence:
--   * an org policy may use a profile from its org or its partner, or the
--     legacy destination from its own org;
--   * a partner policy may use only a profile owned by that same partner.
-- The application resolver follows the same profile-first rule.

-- Migrations run inside one transaction. Establish an explicit system scope
-- before every preflight so FORCE RLS cannot hide tenant rows from the audit.
SELECT set_config('breeze.scope', 'system', true);

-- Re-audit the normalized backup row itself under the explicit system scope.
-- This intentionally repeats the 2026-07-26 checks: that migration established
-- the triggers, while this fix-forward makes the all-tenant preflight explicit.
DO $$
DECLARE
  parent_mismatches integer;
  profile_mismatches integer;
  destination_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO parent_mismatches
  FROM public.config_policy_backup_settings settings
  LEFT JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
  LEFT JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  WHERE link.id IS NULL
     OR link.feature_type <> 'backup'
     OR policy.id IS NULL
     OR settings.org_id IS DISTINCT FROM policy.org_id
     OR settings.partner_id IS DISTINCT FROM policy.partner_id;

  SELECT COUNT(*) INTO profile_mismatches
  FROM public.config_policy_backup_settings settings
  JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
  JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  LEFT JOIN public.organizations policy_org ON policy_org.id = policy.org_id
  LEFT JOIN public.backup_profiles profile ON profile.id = settings.backup_profile_id
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
  FROM public.config_policy_backup_settings settings
  JOIN public.config_policy_feature_links link ON link.id = settings.feature_link_id
  JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
  LEFT JOIN public.backup_configs destination ON destination.id = settings.destination_config_id
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

-- Keep this preflight independent of helper-function EXECUTE privileges. A
-- repeat application must still detect forged rows when invoked through the
-- unprivileged app connection, before reaching any CREATE OR REPLACE DDL.
DO $$
DECLARE
  mismatch record;
  total_mismatches integer := 0;
BEGIN
  FOR mismatch IN
    SELECT link.feature_type, COUNT(*)::integer AS row_count
    FROM public.config_policy_feature_links link
    JOIN public.configuration_policies policy ON policy.id = link.config_policy_id
    LEFT JOIN public.organizations policy_org ON policy_org.id = policy.org_id
    WHERE NOT CASE
      WHEN link.feature_policy_id IS NULL THEN true
      WHEN link.feature_type IN ('monitoring', 'event_log', 'onedrive_helper', 'vulnerability') THEN false
      WHEN link.feature_type = 'patch' THEN EXISTS (
        SELECT 1 FROM public.patch_policies target
        WHERE target.id = link.feature_policy_id
          AND target.kind = 'ring'
          AND target.partner_id = COALESCE(policy.partner_id, policy_org.partner_id)
      )
      WHEN link.feature_type = 'backup' THEN (
        EXISTS (
          SELECT 1 FROM public.backup_profiles target
          WHERE target.id = link.feature_policy_id
            AND (
              (policy.org_id IS NOT NULL AND (
                (target.org_id = policy.org_id AND target.partner_id IS NULL)
                OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
              ))
              OR (policy.partner_id IS NOT NULL
                AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
            )
        )
        OR (
          NOT EXISTS (SELECT 1 FROM public.backup_profiles target WHERE target.id = link.feature_policy_id)
          AND policy.org_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.backup_configs target
            WHERE target.id = link.feature_policy_id AND target.org_id = policy.org_id
          )
        )
      )
      WHEN link.feature_type = 'software_policy' THEN EXISTS (
        SELECT 1 FROM public.software_policies target
        WHERE target.id = link.feature_policy_id AND (
          (policy.org_id IS NOT NULL AND (
            (target.org_id = policy.org_id AND target.partner_id IS NULL)
            OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
          ))
          OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
        )
      )
      WHEN link.feature_type = 'security' THEN EXISTS (
        SELECT 1 FROM public.security_policies target
        WHERE target.id = link.feature_policy_id AND (
          (policy.org_id IS NOT NULL AND (
            (target.org_id = policy.org_id AND target.partner_id IS NULL)
            OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
          ))
          OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
        )
      )
      WHEN link.feature_type = 'alert_rule' THEN EXISTS (
        SELECT 1 FROM public.alert_rules target
        WHERE target.id = link.feature_policy_id AND (
          (policy.org_id IS NOT NULL AND (
            (target.org_id = policy.org_id AND target.partner_id IS NULL)
            OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
          ))
          OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
        )
      )
      WHEN link.feature_type = 'compliance' THEN EXISTS (
        SELECT 1 FROM public.automation_policies target
        WHERE target.id = link.feature_policy_id AND (
          (policy.org_id IS NOT NULL AND (
            (target.org_id = policy.org_id AND target.partner_id IS NULL)
            OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
          ))
          OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
        )
      )
      WHEN link.feature_type = 'sensitive_data' THEN (
        EXISTS (
          SELECT 1 FROM public.sensitive_data_policies target
          WHERE target.id = link.feature_policy_id AND (
            (policy.org_id IS NOT NULL AND (
              (target.org_id = policy.org_id AND target.partner_id IS NULL)
              OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
            ))
            OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
          )
        )
        OR EXISTS (
          SELECT 1 FROM public.configuration_policies target
          WHERE target.id = link.feature_policy_id AND (
            (policy.org_id IS NOT NULL AND target.org_id = policy.org_id)
            OR (target.org_id IS NULL
              AND target.partner_id = COALESCE(policy.partner_id, policy_org.partner_id))
          )
        )
      )
      WHEN link.feature_type = 'peripheral_control' THEN EXISTS (
        SELECT 1 FROM public.peripheral_policies target
        WHERE target.id = link.feature_policy_id AND (
          (policy.org_id IS NOT NULL AND (
            (target.org_id = policy.org_id AND target.partner_id IS NULL)
            OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
          ))
          OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
        )
      )
      WHEN link.feature_type = 'maintenance' THEN EXISTS (
        SELECT 1 FROM public.maintenance_windows target
        WHERE target.id = link.feature_policy_id AND (
          (policy.org_id IS NOT NULL AND (
            (target.org_id = policy.org_id AND target.partner_id IS NULL)
            OR (target.org_id IS NULL AND target.partner_id = policy_org.partner_id)
          ))
          OR (policy.partner_id IS NOT NULL AND target.org_id IS NULL AND target.partner_id = policy.partner_id)
        )
      )
      WHEN link.feature_type IN ('automation', 'helper', 'remote_access', 'pam', 'warranty') THEN (
        policy.org_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.configuration_policies target
          WHERE target.id = link.feature_policy_id AND target.org_id = policy.org_id
        )
      )
      ELSE false
    END
    GROUP BY link.feature_type
  LOOP
    total_mismatches := total_mismatches + mismatch.row_count;
    RAISE WARNING 'config-policy % feature reference preflight found % mismatched row(s)',
      mismatch.feature_type, mismatch.row_count;
  END LOOP;
  IF total_mismatches > 0 THEN
    RAISE EXCEPTION 'configuration feature reference preflight failed; no rows were changed'
      USING ERRCODE = '23514';
  END IF;
END $$;

-- Internal worker: assumes the caller has already established system scope.
-- The public entry point below elevates + restores around it. (A non-superuser
-- migration owner such as prod `doadmin` cannot use a `SET "breeze.scope"`
-- function attribute — that requires privilege to set a custom GUC — so scope is
-- managed explicitly in the wrapper instead.)
CREATE OR REPLACE FUNCTION public.breeze_config_policy_feature_reference_is_valid_impl(
  checked_config_policy_id uuid,
  checked_feature_type public.config_feature_type,
  checked_feature_policy_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
  parent_org_partner_id uuid;
  target_table text;
  target_matches boolean;
  profile_exists boolean;
BEGIN
  SELECT policy.org_id, policy.partner_id, org.partner_id
    INTO parent_org_id, parent_partner_id, parent_org_partner_id
  FROM public.configuration_policies policy
  LEFT JOIN public.organizations org ON org.id = policy.org_id
  WHERE policy.id = checked_config_policy_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF checked_feature_policy_id IS NULL THEN
    RETURN true;
  END IF;

  IF checked_feature_type IN ('monitoring', 'event_log', 'onedrive_helper', 'vulnerability') THEN
    RETURN false;
  END IF;

  IF checked_feature_type = 'patch' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.patch_policies target
      WHERE target.id = checked_feature_policy_id
        AND target.kind = 'ring'
        AND target.partner_id = COALESCE(parent_partner_id, parent_org_partner_id)
    );
  END IF;

  IF checked_feature_type = 'backup' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.backup_profiles profile
      WHERE profile.id = checked_feature_policy_id
    ) INTO profile_exists;
    IF profile_exists THEN
      RETURN EXISTS (
        SELECT 1 FROM public.backup_profiles profile
        WHERE profile.id = checked_feature_policy_id
          AND (
            (parent_org_id IS NOT NULL AND (
              (profile.org_id = parent_org_id AND profile.partner_id IS NULL)
              OR (profile.org_id IS NULL AND profile.partner_id = parent_org_partner_id)
            ))
            OR (parent_partner_id IS NOT NULL
              AND profile.org_id IS NULL
              AND profile.partner_id = parent_partner_id)
          )
      );
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.backup_configs destination
      WHERE destination.id = checked_feature_policy_id
        AND parent_org_id IS NOT NULL
        AND destination.org_id = parent_org_id
    );
  END IF;

  target_table := CASE checked_feature_type
    WHEN 'software_policy' THEN 'software_policies'
    WHEN 'security' THEN 'security_policies'
    WHEN 'alert_rule' THEN 'alert_rules'
    WHEN 'compliance' THEN 'automation_policies'
    WHEN 'sensitive_data' THEN 'sensitive_data_policies'
    WHEN 'peripheral_control' THEN 'peripheral_policies'
    WHEN 'maintenance' THEN 'maintenance_windows'
    ELSE NULL
  END;
  IF target_table IS NOT NULL THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I target WHERE target.id = $1 AND ('
      || '($2 IS NOT NULL AND ((target.org_id = $2 AND target.partner_id IS NULL) '
      || 'OR (target.org_id IS NULL AND target.partner_id = $4))) '
      || 'OR ($3 IS NOT NULL AND target.org_id IS NULL AND target.partner_id = $3)))',
      target_table
    ) INTO target_matches
    USING checked_feature_policy_id, parent_org_id, parent_partner_id, parent_org_partner_id;
    IF target_matches THEN
      RETURN true;
    END IF;
    IF checked_feature_type <> 'sensitive_data' THEN
      RETURN false;
    END IF;
  END IF;

  IF checked_feature_type IN ('sensitive_data', 'automation', 'helper', 'remote_access', 'pam', 'warranty') THEN
    IF checked_feature_type <> 'sensitive_data' AND parent_org_id IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.configuration_policies target
      WHERE target.id = checked_feature_policy_id
        AND (
          (parent_org_id IS NOT NULL AND target.org_id = parent_org_id)
          OR (checked_feature_type = 'sensitive_data'
            AND COALESCE(parent_partner_id, parent_org_partner_id) IS NOT NULL
            AND target.org_id IS NULL
            AND target.partner_id = COALESCE(parent_partner_id, parent_org_partner_id))
        )
    );
  END IF;

  RETURN false;
END;
$$;

-- Public entry point. Elevates to system scope for the cross-tenant read and
-- ALWAYS restores the caller's prior scope before returning. This matters
-- because withDbAccessContext sets breeze.scope once per transaction and holds
-- it for the whole transaction, so a bare SET LOCAL here would leak 'system'
-- into the rest of the request. On any exception the subtransaction/transaction
-- rollback restores breeze.scope automatically, so an explicit restore is only
-- required on the normal return path.
CREATE OR REPLACE FUNCTION public.breeze_config_policy_feature_reference_is_valid(
  checked_config_policy_id uuid,
  checked_feature_type public.config_feature_type,
  checked_feature_policy_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _result boolean;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  _result := public.breeze_config_policy_feature_reference_is_valid_impl(
    checked_config_policy_id, checked_feature_type, checked_feature_policy_id
  );
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN _result;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_validate_config_policy_feature_reference(
  checked_config_policy_id uuid,
  checked_feature_type public.config_feature_type,
  checked_feature_policy_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.breeze_config_policy_feature_reference_is_valid(
    checked_config_policy_id, checked_feature_type, checked_feature_policy_id
  ) THEN
    RAISE EXCEPTION 'feature policy reference is incompatible with its type or parent owner'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_feature_links_reference_owner_fk';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_feature_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.breeze_validate_config_policy_feature_reference(
    NEW.config_policy_id,
    NEW.feature_type,
    NEW.feature_policy_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_feature_links_backup_reference_integrity
  ON public.config_policy_feature_links;
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_integrity
  ON public.config_policy_feature_links;
CREATE TRIGGER config_policy_feature_links_reference_integrity
BEFORE INSERT OR UPDATE OF config_policy_id, feature_type, feature_policy_id
ON public.config_policy_feature_links
FOR EACH ROW EXECUTE FUNCTION public.breeze_enforce_config_policy_feature_reference();

CREATE INDEX IF NOT EXISTS config_feature_links_feature_policy_id_idx
  ON public.config_policy_feature_links (feature_policy_id)
  WHERE feature_policy_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.breeze_revalidate_config_policy_feature_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  link record;
  reference_id uuid;
  prior_reference_id uuid;
BEGIN
  -- Elevate for the cross-tenant candidate reads below; restore before the
  -- (single, end-of-body) return so 'system' does not leak into the rest of the
  -- request transaction. On exception the (sub)transaction rollback restores it.
  PERFORM set_config('breeze.scope', 'system', true);
  reference_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  prior_reference_id := CASE WHEN TG_OP = 'UPDATE' THEN OLD.id ELSE reference_id END;

  IF TG_TABLE_NAME = 'configuration_policies' THEN
    FOR link IN
      SELECT candidate.*
      FROM public.config_policy_feature_links candidate
      WHERE candidate.config_policy_id IN (reference_id, prior_reference_id)
         OR candidate.feature_policy_id IN (reference_id, prior_reference_id)
    LOOP
      PERFORM public.breeze_validate_config_policy_feature_reference(
        link.config_policy_id, link.feature_type, link.feature_policy_id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    FOR link IN
      SELECT candidate.*
      FROM public.config_policy_feature_links candidate
      JOIN public.configuration_policies policy ON policy.id = candidate.config_policy_id
      WHERE policy.org_id IN (reference_id, prior_reference_id)
    LOOP
      PERFORM public.breeze_validate_config_policy_feature_reference(
        link.config_policy_id, link.feature_type, link.feature_policy_id
      );
    END LOOP;
  ELSE
    FOR link IN
      SELECT candidate.*
      FROM public.config_policy_feature_links candidate
      WHERE candidate.feature_policy_id IN (reference_id, prior_reference_id)
    LOOP
      PERFORM public.breeze_validate_config_policy_feature_reference(
        link.config_policy_id, link.feature_type, link.feature_policy_id
      );
    END LOOP;
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Remove the development-version backup-only reverse triggers before installing
-- the type-complete trigger set. These drops are harmless on fresh databases.
DROP TRIGGER IF EXISTS config_policy_feature_links_backup_policy_owner_update
  ON public.configuration_policies;
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_policy_update
  ON public.configuration_policies;
CREATE TRIGGER config_policy_feature_links_reference_policy_update
AFTER UPDATE OF id, org_id, partner_id ON public.configuration_policies
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_references();
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_policy_delete
  ON public.configuration_policies;
CREATE TRIGGER config_policy_feature_links_reference_policy_delete
AFTER DELETE ON public.configuration_policies
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_references();

DROP TRIGGER IF EXISTS config_policy_feature_links_backup_org_partner_update
  ON public.organizations;
DROP TRIGGER IF EXISTS config_policy_feature_links_reference_org_partner_update
  ON public.organizations;
CREATE TRIGGER config_policy_feature_links_reference_org_partner_update
AFTER UPDATE OF partner_id ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_references();

DO $$
DECLARE
  table_name text;
  trigger_prefix text;
  update_columns text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'patch_policies', 'software_policies', 'security_policies', 'alert_rules',
    'automation_policies', 'sensitive_data_policies', 'peripheral_policies',
    'maintenance_windows', 'backup_profiles', 'backup_configs'
  ] LOOP
    trigger_prefix := 'config_policy_feature_ref_' || table_name;
    update_columns := CASE table_name
      WHEN 'patch_policies' THEN 'id, partner_id, kind'
      WHEN 'backup_configs' THEN 'id, org_id'
      ELSE 'id, org_id, partner_id'
    END;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_prefix || '_insert', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_prefix || '_update', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_prefix || '_delete', table_name);
    IF table_name = 'backup_profiles' THEN
      -- A profile UUID takes precedence over the legacy backup_configs UUID;
      -- insertion can therefore invalidate an existing config-backed link.
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_references()',
        trigger_prefix || '_insert', table_name
      );
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE OF %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_references()',
      trigger_prefix || '_update', update_columns, table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_feature_references()',
      trigger_prefix || '_delete', table_name
    );
  END LOOP;
END $$;

-- Drop obsolete backup-only triggers/functions if this unshipped migration was
-- exercised in a development database before the type-complete revision.
DROP TRIGGER IF EXISTS config_policy_feature_links_backup_profile_insert ON public.backup_profiles;
DROP TRIGGER IF EXISTS config_policy_feature_links_backup_profile_update ON public.backup_profiles;
DROP TRIGGER IF EXISTS config_policy_feature_links_backup_profile_delete ON public.backup_profiles;
DROP TRIGGER IF EXISTS config_policy_feature_links_backup_destination_update ON public.backup_configs;
DROP TRIGGER IF EXISTS config_policy_feature_links_backup_destination_delete ON public.backup_configs;
DROP FUNCTION IF EXISTS public.breeze_enforce_backup_feature_policy_reference();
DROP FUNCTION IF EXISTS public.breeze_revalidate_backup_feature_policy_references();
DROP FUNCTION IF EXISTS public.breeze_validate_backup_feature_policy_reference(uuid, public.config_feature_type, uuid);

REVOKE ALL ON FUNCTION public.breeze_config_policy_feature_reference_is_valid(uuid, public.config_feature_type, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_feature_reference(uuid, public.config_feature_type, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_feature_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_references() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_config_policy_feature_reference_is_valid(uuid, public.config_feature_type, uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_feature_reference(uuid, public.config_feature_type, uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_feature_reference() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_feature_references() FROM breeze_app;
  END IF;
END $$;
