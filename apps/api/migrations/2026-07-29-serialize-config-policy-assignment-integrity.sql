-- Serialize polymorphic assignment validation with target/policy owner moves.
-- The 07-28 row validator could observe an old committed owner, then wait in
-- the later export-watermark trigger and commit after that owner changed.

DO $$
DECLARE mismatch_count integer;
BEGIN
  PERFORM pg_catalog.set_config('breeze.scope', 'system', true);
  PERFORM pg_catalog.set_config('breeze.accessible_org_ids', '', true);
  PERFORM pg_catalog.set_config('breeze.accessible_partner_ids', '', true);
  WITH resolved AS (
    SELECT assignment.level, assignment.target_id,
      policy.org_id AS policy_org_id,
      COALESCE(policy.partner_id, policy_org.partner_id) AS policy_partner_id,
      CASE assignment.level
        WHEN 'organization' THEN target_org.id
        WHEN 'site' THEN target_site.org_id
        WHEN 'device_group' THEN target_group.org_id
        WHEN 'device' THEN target_device.org_id
      END AS target_org_id
    FROM public.config_policy_assignments assignment
    JOIN public.configuration_policies policy ON policy.id = assignment.config_policy_id
    LEFT JOIN public.organizations policy_org ON policy_org.id = policy.org_id
    LEFT JOIN public.organizations target_org
      ON assignment.level = 'organization' AND target_org.id = assignment.target_id
    LEFT JOIN public.sites target_site
      ON assignment.level = 'site' AND target_site.id = assignment.target_id
    LEFT JOIN public.device_groups target_group
      ON assignment.level = 'device_group' AND target_group.id = assignment.target_id
    LEFT JOIN public.devices target_device
      ON assignment.level = 'device' AND target_device.id = assignment.target_id
  ), checked AS (
    SELECT resolved.*, target_owner.partner_id AS target_partner_id
    FROM resolved
    LEFT JOIN public.organizations target_owner ON target_owner.id = resolved.target_org_id
  )
  SELECT COUNT(*) INTO mismatch_count FROM checked
  WHERE policy_partner_id IS NULL
     OR (level = 'partner' AND target_id IS DISTINCT FROM policy_partner_id)
     OR (level <> 'partner' AND (
       target_org_id IS NULL
       OR target_partner_id IS DISTINCT FROM policy_partner_id
       OR (policy_org_id IS NOT NULL AND target_org_id IS DISTINCT FROM policy_org_id)
     ));
  IF mismatch_count > 0 THEN
    RAISE WARNING 'config_policy_assignments serialization preflight found % mismatched row(s)', mismatch_count;
    RAISE EXCEPTION 'config-policy assignment serialization preflight failed; no rows were changed'
      USING ERRCODE = '23514', CONSTRAINT = 'config_policy_assignments_target_owner_check';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_lock_config_policy_assignment_rows(
  row_values jsonb[],
  extra_org_ids uuid[] DEFAULT ARRAY[]::uuid[],
  extra_partner_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  org_ids uuid[];
  partner_ids uuid[];
BEGIN
  WITH assignment_rows AS (
    SELECT value,
      NULLIF(value->>'config_policy_id', '')::uuid AS policy_id,
      value->>'level' AS level,
      NULLIF(value->>'target_id', '')::uuid AS target_id
    FROM unnest(COALESCE(row_values, ARRAY[]::jsonb[])) value
  ), policy_owners AS (
    SELECT DISTINCT policy.org_id,
      COALESCE(policy.partner_id, policy_org.partner_id) AS partner_id
    FROM assignment_rows assignment
    JOIN public.configuration_policies policy ON policy.id = assignment.policy_id
    LEFT JOIN public.organizations policy_org ON policy_org.id = policy.org_id
  ), target_owners AS (
    SELECT DISTINCT
      CASE assignment.level
        WHEN 'organization' THEN target_org.id
        WHEN 'site' THEN target_site.org_id
        WHEN 'device_group' THEN target_group.org_id
        WHEN 'device' THEN target_device.org_id
      END AS org_id,
      CASE assignment.level
        WHEN 'partner' THEN assignment.target_id
        ELSE target_owner.partner_id
      END AS partner_id
    FROM assignment_rows assignment
    LEFT JOIN public.organizations target_org
      ON assignment.level = 'organization' AND target_org.id = assignment.target_id
    LEFT JOIN public.sites target_site
      ON assignment.level = 'site' AND target_site.id = assignment.target_id
    LEFT JOIN public.device_groups target_group
      ON assignment.level = 'device_group' AND target_group.id = assignment.target_id
    LEFT JOIN public.devices target_device
      ON assignment.level = 'device' AND target_device.id = assignment.target_id
    LEFT JOIN public.organizations target_owner ON target_owner.id = CASE assignment.level
      WHEN 'organization' THEN target_org.id
      WHEN 'site' THEN target_site.org_id
      WHEN 'device_group' THEN target_group.org_id
      WHEN 'device' THEN target_device.org_id
    END
  ), requested_orgs AS (
    SELECT org_id FROM policy_owners WHERE org_id IS NOT NULL
    UNION SELECT org_id FROM target_owners WHERE org_id IS NOT NULL
    UNION SELECT value FROM unnest(COALESCE(extra_org_ids, ARRAY[]::uuid[])) value WHERE value IS NOT NULL
  ), requested_partners AS (
    SELECT partner_id FROM policy_owners WHERE partner_id IS NOT NULL
    UNION SELECT partner_id FROM target_owners WHERE partner_id IS NOT NULL
    UNION SELECT value FROM unnest(COALESCE(extra_partner_ids, ARRAY[]::uuid[])) value WHERE value IS NOT NULL
    UNION SELECT organization.partner_id
      FROM public.organizations organization JOIN requested_orgs ON requested_orgs.org_id = organization.id
  )
  SELECT
    ARRAY(SELECT DISTINCT partner_id FROM requested_partners ORDER BY partner_id),
    ARRAY(SELECT DISTINCT org_id FROM requested_orgs ORDER BY org_id)
  INTO partner_ids, org_ids;

  IF cardinality(partner_ids) > 0 THEN
    PERFORM public.breeze_partner_export_lock_partners_exclusive(partner_ids);
  END IF;
  IF cardinality(org_ids) > 0 THEN
    PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(org_ids, partner_ids);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_validate_config_policy_assignment_target(
  checked_policy_id uuid,
  checked_level text,
  checked_target_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  policy_org_id uuid;
  policy_partner_id uuid;
  target_org_id uuid;
  target_partner_id uuid;
BEGIN
  -- The assignment FK already holds KEY SHARE on this policy for INSERT and
  -- config_policy_id UPDATE. Keep the explicit lock for direct validation
  -- callers; target rows deliberately rely on the canonical advisory lock so
  -- a reverse writer cannot hold a target row lock while waiting on us.
  SELECT policy.org_id, policy.partner_id INTO policy_org_id, policy_partner_id
  FROM public.configuration_policies policy
  WHERE policy.id = checked_policy_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'configuration policy owner could not be resolved'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_assignments_policy_owner_fk';
  END IF;
  IF policy_org_id IS NOT NULL THEN
    SELECT organization.partner_id INTO policy_partner_id
    FROM public.organizations organization WHERE organization.id = policy_org_id;
  END IF;
  IF policy_partner_id IS NULL THEN
    RAISE EXCEPTION 'configuration policy owner could not be resolved'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_assignments_policy_owner_fk';
  END IF;

  IF checked_level = 'partner' THEN
    IF checked_target_id IS DISTINCT FROM policy_partner_id THEN
      RAISE EXCEPTION 'partner assignment target must match the policy owner partner'
        USING ERRCODE = '23503', CONSTRAINT = 'config_policy_assignments_target_owner_fk';
    END IF;
    RETURN;
  ELSIF checked_level = 'organization' THEN
    SELECT organization.id, organization.partner_id INTO target_org_id, target_partner_id
    FROM public.organizations organization WHERE organization.id = checked_target_id;
  ELSIF checked_level = 'site' THEN
    SELECT site.org_id, organization.partner_id INTO target_org_id, target_partner_id
    FROM public.sites site JOIN public.organizations organization ON organization.id = site.org_id
    WHERE site.id = checked_target_id;
  ELSIF checked_level = 'device_group' THEN
    SELECT device_group.org_id, organization.partner_id INTO target_org_id, target_partner_id
    FROM public.device_groups device_group
    JOIN public.organizations organization ON organization.id = device_group.org_id
    WHERE device_group.id = checked_target_id;
  ELSIF checked_level = 'device' THEN
    SELECT device.org_id, organization.partner_id INTO target_org_id, target_partner_id
    FROM public.devices device JOIN public.organizations organization ON organization.id = device.org_id
    WHERE device.id = checked_target_id;
  ELSE
    RAISE EXCEPTION 'unsupported configuration assignment level'
      USING ERRCODE = '23514', CONSTRAINT = 'config_policy_assignments_level_check';
  END IF;
  IF target_org_id IS NULL
     OR target_partner_id IS DISTINCT FROM policy_partner_id
     OR (policy_org_id IS NOT NULL AND target_org_id IS DISTINCT FROM policy_org_id) THEN
    RAISE EXCEPTION 'configuration assignment target is incompatible with the policy owner'
      USING ERRCODE = '23503', CONSTRAINT = 'config_policy_assignments_target_owner_fk';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_validate_config_policy_assignment_new_rows(row_values jsonb[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE assignment_row jsonb;
BEGIN
  FOR assignment_row IN
    SELECT value FROM unnest(COALESCE(row_values, ARRAY[]::jsonb[])) value
    ORDER BY value->>'config_policy_id', value->>'level', value->>'target_id', value->>'id'
  LOOP
    PERFORM public.breeze_validate_config_policy_assignment_target(
      (assignment_row->>'config_policy_id')::uuid,
      assignment_row->>'level',
      (assignment_row->>'target_id')::uuid
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_assignment_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = '' AS $$
DECLARE values jsonb[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO values FROM new_rows row;
  PERFORM public.breeze_lock_config_policy_assignment_rows(values);
  PERFORM public.breeze_validate_config_policy_assignment_new_rows(values);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_assignment_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = '' AS $$
DECLARE old_values jsonb[]; new_values jsonb[]; all_values jsonb[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO old_values FROM old_rows row;
  SELECT array_agg(to_jsonb(row)) INTO new_values FROM new_rows row;
  all_values := COALESCE(old_values, ARRAY[]::jsonb[]) || COALESCE(new_values, ARRAY[]::jsonb[]);
  PERFORM public.breeze_lock_config_policy_assignment_rows(all_values);
  PERFORM public.breeze_validate_config_policy_assignment_new_rows(new_values);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_assignment_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = '' AS $$
DECLARE values jsonb[];
BEGIN
  SELECT array_agg(to_jsonb(row)) INTO values FROM old_rows row;
  PERFORM public.breeze_lock_config_policy_assignment_rows(values);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET breeze.scope = 'system'
SET breeze.accessible_org_ids = ''
SET breeze.accessible_partner_ids = ''
AS $$
DECLARE
  values jsonb[] := ARRAY[]::jsonb[];
  org_ids uuid[] := ARRAY[]::uuid[];
  partner_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_TABLE_NAME = 'configuration_policies' THEN
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment WHERE assignment.config_policy_id = OLD.id;
    org_ids := array_remove(ARRAY[OLD.org_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.org_id END], NULL);
    partner_ids := array_remove(ARRAY[OLD.partner_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.partner_id END], NULL);
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    SELECT COALESCE(array_agg(DISTINCT to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    JOIN public.configuration_policies policy ON policy.id = assignment.config_policy_id
    WHERE policy.org_id = OLD.id
       OR (assignment.level = 'organization' AND assignment.target_id = OLD.id)
       OR (assignment.level = 'site' AND EXISTS (
         SELECT 1 FROM public.sites site WHERE site.id = assignment.target_id AND site.org_id = OLD.id))
       OR (assignment.level = 'device_group' AND EXISTS (
         SELECT 1 FROM public.device_groups device_group
         WHERE device_group.id = assignment.target_id AND device_group.org_id = OLD.id))
       OR (assignment.level = 'device' AND EXISTS (
         SELECT 1 FROM public.devices device WHERE device.id = assignment.target_id AND device.org_id = OLD.id));
    org_ids := array_remove(ARRAY[OLD.id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.id END], NULL);
    partner_ids := array_remove(ARRAY[OLD.partner_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.partner_id END], NULL);
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.target_id = OLD.id
      AND assignment.level::text = CASE TG_TABLE_NAME
        WHEN 'sites' THEN 'site'
        WHEN 'device_groups' THEN 'device_group'
        WHEN 'devices' THEN 'device'
      END;
    org_ids := array_remove(ARRAY[
      OLD.org_id,
      CASE WHEN TG_OP = 'UPDATE' THEN NEW.org_id END
    ], NULL);
  END IF;
  PERFORM public.breeze_lock_config_policy_assignment_rows(values, org_ids, partner_ids);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Recreate the 07-28 reverse validator with a fixed system context. Its AFTER
-- checks run under locks acquired by the BEFORE serializer above.
ALTER FUNCTION public.breeze_enforce_config_policy_assignment_target()
  SET breeze.scope = 'system';
ALTER FUNCTION public.breeze_enforce_config_policy_assignment_target()
  SET breeze.accessible_org_ids = '';
ALTER FUNCTION public.breeze_enforce_config_policy_assignment_target()
  SET breeze.accessible_partner_ids = '';
ALTER FUNCTION public.breeze_revalidate_config_policy_assignment_targets()
  SET breeze.scope = 'system';
ALTER FUNCTION public.breeze_revalidate_config_policy_assignment_targets()
  SET breeze.accessible_org_ids = '';
ALTER FUNCTION public.breeze_revalidate_config_policy_assignment_targets()
  SET breeze.accessible_partner_ids = '';

DROP TRIGGER IF EXISTS config_policy_assignment_target_integrity ON public.config_policy_assignments;
DROP TRIGGER IF EXISTS a_config_policy_assignment_integrity_insert ON public.config_policy_assignments;
CREATE TRIGGER a_config_policy_assignment_integrity_insert
AFTER INSERT ON public.config_policy_assignments
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_insert();
DROP TRIGGER IF EXISTS a_config_policy_assignment_integrity_update ON public.config_policy_assignments;
CREATE TRIGGER a_config_policy_assignment_integrity_update
AFTER UPDATE ON public.config_policy_assignments
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_update();
DROP TRIGGER IF EXISTS a_config_policy_assignment_integrity_delete ON public.config_policy_assignments;
CREATE TRIGGER a_config_policy_assignment_integrity_delete
AFTER DELETE ON public.config_policy_assignments
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_delete();

DROP TRIGGER IF EXISTS aa_config_policy_assignment_owner_serialize_update ON public.configuration_policies;
CREATE TRIGGER aa_config_policy_assignment_owner_serialize_update
BEFORE UPDATE OF org_id, partner_id ON public.configuration_policies FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();
DROP TRIGGER IF EXISTS aa_config_policy_assignment_owner_serialize_delete ON public.configuration_policies;
CREATE TRIGGER aa_config_policy_assignment_owner_serialize_delete
BEFORE DELETE ON public.configuration_policies FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();

DROP TRIGGER IF EXISTS aa_config_policy_assignment_org_serialize_update ON public.organizations;
CREATE TRIGGER aa_config_policy_assignment_org_serialize_update
BEFORE UPDATE OF id, partner_id ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();
DROP TRIGGER IF EXISTS aa_config_policy_assignment_org_serialize_delete ON public.organizations;
CREATE TRIGGER aa_config_policy_assignment_org_serialize_delete
BEFORE DELETE ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();

DROP TRIGGER IF EXISTS aa_config_policy_assignment_site_serialize_update ON public.sites;
CREATE TRIGGER aa_config_policy_assignment_site_serialize_update
BEFORE UPDATE OF id, org_id ON public.sites FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();
DROP TRIGGER IF EXISTS aa_config_policy_assignment_site_serialize_delete ON public.sites;
CREATE TRIGGER aa_config_policy_assignment_site_serialize_delete
BEFORE DELETE ON public.sites FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();

DROP TRIGGER IF EXISTS aa_config_policy_assignment_group_serialize_update ON public.device_groups;
CREATE TRIGGER aa_config_policy_assignment_group_serialize_update
BEFORE UPDATE OF id, org_id ON public.device_groups FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();
DROP TRIGGER IF EXISTS aa_config_policy_assignment_group_serialize_delete ON public.device_groups;
CREATE TRIGGER aa_config_policy_assignment_group_serialize_delete
BEFORE DELETE ON public.device_groups FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();

DROP TRIGGER IF EXISTS aa_config_policy_assignment_device_serialize_update ON public.devices;
CREATE TRIGGER aa_config_policy_assignment_device_serialize_update
BEFORE UPDATE OF id, org_id ON public.devices FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();
DROP TRIGGER IF EXISTS aa_config_policy_assignment_device_serialize_delete ON public.devices;
CREATE TRIGGER aa_config_policy_assignment_device_serialize_delete
BEFORE DELETE ON public.devices FOR EACH ROW
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_change();

REVOKE ALL ON FUNCTION public.breeze_lock_config_policy_assignment_rows(jsonb[], uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_assignment_target(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_assignment_new_rows(jsonb[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_assignment_targets() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_lock_config_policy_assignment_rows(jsonb[], uuid[], uuid[]) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_assignment_target(uuid, text, uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_assignment_new_rows(jsonb[]) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_insert() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_update() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_delete() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_change() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_target() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_assignment_targets() FROM breeze_app;
  END IF;
END $$;
