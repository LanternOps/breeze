-- Config-policy assignments use a polymorphic target_id, so ordinary foreign
-- keys cannot enforce that a target belongs to the policy's tenant. Validate
-- both directions in PostgreSQL: assignment writes and later owner moves or
-- target deletion. Abort pre-existing mismatches rather than repairing them;
-- they can be evidence of a cross-tenant write.

DO $$
DECLARE
  mismatch_count integer;
BEGIN
  -- This preflight must also work when a non-superuser applies migrations.
  -- Forced-RLS tables are intentionally read under the explicit system scope.
  PERFORM pg_catalog.set_config('breeze.scope', 'system', true);
  PERFORM pg_catalog.set_config('breeze.accessible_org_ids', '', true);
  PERFORM pg_catalog.set_config('breeze.accessible_partner_ids', '', true);

  WITH resolved AS (
    SELECT assignment.id, assignment.level, assignment.target_id,
      policy.org_id AS policy_org_id,
      COALESCE(policy.partner_id, policy_org.partner_id) AS policy_partner_id,
      CASE assignment.level
        WHEN 'organization' THEN target_org.id
        WHEN 'site' THEN target_site.org_id
        WHEN 'device_group' THEN target_group.org_id
        WHEN 'device' THEN target_device.org_id
        ELSE NULL
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
  SELECT COUNT(*) INTO mismatch_count
  FROM checked
  WHERE policy_partner_id IS NULL
     OR (level = 'partner' AND target_id IS DISTINCT FROM policy_partner_id)
     OR (level <> 'partner' AND (
       target_org_id IS NULL
       OR target_partner_id IS DISTINCT FROM policy_partner_id
       OR (policy_org_id IS NOT NULL AND target_org_id IS DISTINCT FROM policy_org_id)
     ));

  IF mismatch_count > 0 THEN
    RAISE WARNING 'config_policy_assignments target-integrity preflight found % mismatched row(s)', mismatch_count;
    RAISE EXCEPTION 'config-policy assignment target-integrity preflight failed; no rows were changed'
      USING ERRCODE = '23514', CONSTRAINT = 'config_policy_assignments_target_owner_check';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_validate_config_policy_assignment_target(
  checked_policy_id uuid,
  checked_level text,
  checked_target_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  policy_org_id uuid;
  policy_partner_id uuid;
  target_org_id uuid;
  target_partner_id uuid;
BEGIN
  SELECT policy.org_id, COALESCE(policy.partner_id, owner.partner_id)
    INTO policy_org_id, policy_partner_id
  FROM public.configuration_policies policy
  LEFT JOIN public.organizations owner ON owner.id = policy.org_id
  WHERE policy.id = checked_policy_id;

  IF NOT FOUND OR policy_partner_id IS NULL THEN
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
    FROM public.sites site
    JOIN public.organizations organization ON organization.id = site.org_id
    WHERE site.id = checked_target_id;
  ELSIF checked_level = 'device_group' THEN
    SELECT device_group.org_id, organization.partner_id INTO target_org_id, target_partner_id
    FROM public.device_groups device_group
    JOIN public.organizations organization ON organization.id = device_group.org_id
    WHERE device_group.id = checked_target_id;
  ELSIF checked_level = 'device' THEN
    SELECT device.org_id, organization.partner_id INTO target_org_id, target_partner_id
    FROM public.devices device
    JOIN public.organizations organization ON organization.id = device.org_id
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

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_assignment_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.breeze_validate_config_policy_assignment_target(
    NEW.config_policy_id, NEW.level::text, NEW.target_id
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_revalidate_config_policy_assignment_targets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  assignment_row record;
BEGIN
  IF TG_TABLE_NAME = 'configuration_policies' THEN
    FOR assignment_row IN
      SELECT assignment.config_policy_id, assignment.level::text AS level, assignment.target_id
      FROM public.config_policy_assignments assignment
      WHERE assignment.config_policy_id = NEW.id
    LOOP
      PERFORM public.breeze_validate_config_policy_assignment_target(
        assignment_row.config_policy_id, assignment_row.level, assignment_row.target_id
      );
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'organizations' THEN
    FOR assignment_row IN
      SELECT DISTINCT assignment.config_policy_id, assignment.level::text AS level, assignment.target_id
      FROM public.config_policy_assignments assignment
      JOIN public.configuration_policies policy ON policy.id = assignment.config_policy_id
      WHERE policy.org_id = OLD.id
         OR (assignment.level = 'organization' AND assignment.target_id = OLD.id)
         OR (assignment.level = 'site' AND EXISTS (
           SELECT 1 FROM public.sites site
           WHERE site.id = assignment.target_id AND site.org_id = OLD.id
         ))
         OR (assignment.level = 'device_group' AND EXISTS (
           SELECT 1 FROM public.device_groups device_group
           WHERE device_group.id = assignment.target_id AND device_group.org_id = OLD.id
         ))
         OR (assignment.level = 'device' AND EXISTS (
           SELECT 1 FROM public.devices device
           WHERE device.id = assignment.target_id AND device.org_id = OLD.id
         ))
    LOOP
      PERFORM public.breeze_validate_config_policy_assignment_target(
        assignment_row.config_policy_id, assignment_row.level, assignment_row.target_id
      );
    END LOOP;
  ELSE
    FOR assignment_row IN
      SELECT assignment.config_policy_id, assignment.level::text AS level, assignment.target_id
      FROM public.config_policy_assignments assignment
      WHERE assignment.target_id = OLD.id
        AND assignment.level = CASE TG_TABLE_NAME
          WHEN 'sites' THEN 'site'::public.config_assignment_level
          WHEN 'device_groups' THEN 'device_group'::public.config_assignment_level
          WHEN 'devices' THEN 'device'::public.config_assignment_level
        END
    LOOP
      PERFORM public.breeze_validate_config_policy_assignment_target(
        assignment_row.config_policy_id, assignment_row.level, assignment_row.target_id
      );
    END LOOP;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS config_policy_assignment_target_integrity ON public.config_policy_assignments;
CREATE TRIGGER config_policy_assignment_target_integrity
BEFORE INSERT OR UPDATE OF config_policy_id, level, target_id
ON public.config_policy_assignments
FOR EACH ROW EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_target();

-- PostgreSQL runs same-kind triggers alphabetically. The a_ prefix keeps
-- reverse validation ahead of the existing breeze_partner_export_* material
-- touch/lock triggers, so a rejected owner move cannot acquire export locks.
DROP TRIGGER IF EXISTS config_policy_assignment_policy_owner_update ON public.configuration_policies;
DROP TRIGGER IF EXISTS a_config_policy_assignment_policy_owner_update ON public.configuration_policies;
CREATE TRIGGER a_config_policy_assignment_policy_owner_update
AFTER UPDATE OF org_id, partner_id ON public.configuration_policies
FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_assignment_targets();

DO $$
DECLARE
  table_name text;
  column_list text;
BEGIN
  FOR table_name, column_list IN VALUES
    ('organizations', 'id, partner_id'),
    ('sites', 'id, org_id'),
    ('device_groups', 'id, org_id'),
    ('devices', 'id, org_id')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS config_policy_assignment_target_update ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS a_config_policy_assignment_target_update ON public.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER a_config_policy_assignment_target_update AFTER UPDATE OF %s ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_assignment_targets()',
      column_list, table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS config_policy_assignment_target_delete ON public.%I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS a_config_policy_assignment_target_delete ON public.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER a_config_policy_assignment_target_delete AFTER DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.breeze_revalidate_config_policy_assignment_targets()',
      table_name
    );
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_assignment_target(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_assignment_targets() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_validate_config_policy_assignment_target(uuid, text, uuid) FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_target() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_revalidate_config_policy_assignment_targets() FROM breeze_app;
  END IF;
END $$;
