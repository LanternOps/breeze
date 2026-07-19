-- Serialize assignment integrity independently from the partner-export lock
-- hierarchy.  The 07-29 reverse row trigger acquired export locks one row at
-- a time, which made otherwise-valid bulk mutations order-dependent and made
-- assignment writes incompatible with transactions already holding a shared
-- export-partner lock.

CREATE OR REPLACE FUNCTION public.breeze_enforce_config_policy_assignment_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Prod migrates as a non-superuser that cannot SET custom breeze.* GUCs as
  -- function attributes (42501), so elevate in-body and restore the caller's
  -- context before every normal return. breeze.* is held for the whole request
  -- transaction, so a leaked 'system' scope would be an RLS hole; error paths
  -- restore automatically via (sub)transaction rollback.
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  row_values jsonb[] := ARRAY[]::jsonb[];
  new_values jsonb[] := ARRAY[]::jsonb[];
  target_row record;
  lock_key integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(array_agg(to_jsonb(row)), ARRAY[]::jsonb[])
      INTO row_values FROM new_rows row;
    new_values := row_values;
  ELSIF TG_OP = 'UPDATE' THEN
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

  -- Stabilize every polymorphic target before resolving its owner.  No
  -- assignment-integrity advisory lock is held while waiting on these rows,
  -- so a reverse writer can always reach its AFTER STATEMENT serializer.
  FOR target_row IN
    SELECT DISTINCT value->>'level' AS level,
      (value->>'target_id')::uuid AS target_id
    FROM unnest(row_values) value
    WHERE value->>'level' <> 'partner'
    ORDER BY level, target_id
  LOOP
    IF target_row.level = 'organization' THEN
      PERFORM organization.id FROM public.organizations organization
      WHERE organization.id = target_row.target_id FOR KEY SHARE;
    ELSIF target_row.level = 'site' THEN
      PERFORM site.id FROM public.sites site
      WHERE site.id = target_row.target_id FOR KEY SHARE;
    ELSIF target_row.level = 'device_group' THEN
      PERFORM device_group.id FROM public.device_groups device_group
      WHERE device_group.id = target_row.target_id FOR KEY SHARE;
    ELSIF target_row.level = 'device' THEN
      PERFORM device.id FROM public.devices device
      WHERE device.id = target_row.target_id FOR KEY SHARE;
    END IF;
  END LOOP;

  -- The assignment FK already takes this lock on INSERT and policy-id UPDATE;
  -- keep the explicit ordered pass for old UPDATE rows and DELETE statements.
  PERFORM policy.id
  FROM public.configuration_policies policy
  JOIN (
    SELECT DISTINCT (value->>'config_policy_id')::uuid AS id
    FROM unnest(row_values) value
  ) requested ON requested.id = policy.id
  ORDER BY policy.id
  FOR KEY SHARE OF policy;

  -- Stabilize owner rows after targets and policies.  A concurrent owner move
  -- therefore completes before owner identities are derived below.
  PERFORM organization.id
  FROM public.organizations organization
  JOIN (
    WITH assignment_rows AS (
      SELECT (value->>'config_policy_id')::uuid AS policy_id,
        value->>'level' AS level,
        (value->>'target_id')::uuid AS target_id
      FROM unnest(row_values) value
    )
    SELECT policy.org_id AS id
    FROM assignment_rows assignment
    JOIN public.configuration_policies policy ON policy.id = assignment.policy_id
    WHERE policy.org_id IS NOT NULL
    UNION
    SELECT CASE assignment.level
      WHEN 'organization' THEN target_org.id
      WHEN 'site' THEN target_site.org_id
      WHEN 'device_group' THEN target_group.org_id
      WHEN 'device' THEN target_device.org_id
    END
    FROM assignment_rows assignment
    LEFT JOIN public.organizations target_org
      ON assignment.level = 'organization' AND target_org.id = assignment.target_id
    LEFT JOIN public.sites target_site
      ON assignment.level = 'site' AND target_site.id = assignment.target_id
    LEFT JOIN public.device_groups target_group
      ON assignment.level = 'device_group' AND target_group.id = assignment.target_id
    LEFT JOIN public.devices target_device
      ON assignment.level = 'device' AND target_device.id = assignment.target_id
  ) requested ON requested.id = organization.id
  ORDER BY organization.id
  FOR KEY SHARE OF organization;

  -- 1000301 is dedicated to assignment integrity.  Sort and deduplicate the
  -- physical advisory keys, not just their logical identities, so a hash
  -- collision remains conservative and cannot create inconsistent ordering.
  FOR lock_key IN
    WITH assignment_rows AS (
      SELECT (value->>'config_policy_id')::uuid AS policy_id,
        value->>'level' AS level,
        (value->>'target_id')::uuid AS target_id
      FROM unnest(row_values) value
    ), policy_owners AS (
      SELECT assignment.policy_id, policy.org_id,
        COALESCE(policy.partner_id, policy_org.partner_id) AS partner_id
      FROM assignment_rows assignment
      LEFT JOIN public.configuration_policies policy ON policy.id = assignment.policy_id
      LEFT JOIN public.organizations policy_org ON policy_org.id = policy.org_id
    ), target_owners AS (
      SELECT assignment.level, assignment.target_id,
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
    ), identities AS (
      SELECT 'policy:' || policy_id::text AS identity FROM assignment_rows
      UNION SELECT 'target:' || level || ':' || target_id::text FROM assignment_rows
      UNION SELECT 'org:' || org_id::text FROM policy_owners WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM policy_owners WHERE partner_id IS NOT NULL
      UNION SELECT 'org:' || org_id::text FROM target_owners WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM target_owners WHERE partner_id IS NOT NULL
    )
    SELECT DISTINCT hashtext(identity) FROM identities ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000301, lock_key);
  END LOOP;

  IF TG_OP <> 'DELETE' THEN
    PERFORM public.breeze_validate_config_policy_assignment_new_rows(new_values);
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  identities text[] := ARRAY[]::text[];
  values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
BEGIN
  -- Transition tables have no row-order contract.  Compare owner tuples as
  -- sets so unrelated updates take no integrity locks without pairing rows by
  -- physical execution order.
  IF TG_TABLE_NAME = 'configuration_policies' THEN
    IF NOT EXISTS (
      (SELECT id, org_id, partner_id FROM old_rows
        EXCEPT SELECT id, org_id, partner_id FROM new_rows)
      UNION ALL
      (SELECT id, org_id, partner_id FROM new_rows
        EXCEPT SELECT id, org_id, partner_id FROM old_rows)
    ) THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    IF NOT EXISTS (
      (SELECT id, partner_id FROM old_rows EXCEPT SELECT id, partner_id FROM new_rows)
      UNION ALL
      (SELECT id, partner_id FROM new_rows EXCEPT SELECT id, partner_id FROM old_rows)
    ) THEN RETURN NULL; END IF;
  ELSE
    IF NOT EXISTS (
      (SELECT id, org_id FROM old_rows EXCEPT SELECT id, org_id FROM new_rows)
      UNION ALL
      (SELECT id, org_id FROM new_rows EXCEPT SELECT id, org_id FROM old_rows)
    ) THEN RETURN NULL; END IF;
  END IF;

  -- Elevate only past the no-op gates above: they read nothing but transition
  -- tables, so their RETURN NULL paths carry no scope to restore.
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);

  IF TG_TABLE_NAME = 'configuration_policies' THEN
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'policy:' || id::text AS identity FROM old_rows
      UNION SELECT 'policy:' || id::text FROM new_rows
      UNION SELECT 'org:' || org_id::text FROM old_rows WHERE org_id IS NOT NULL
      UNION SELECT 'org:' || org_id::text FROM new_rows WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM old_rows WHERE partner_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM new_rows WHERE partner_id IS NOT NULL
    ) keys;
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'target:organization:' || id::text AS identity FROM old_rows
      UNION SELECT 'target:organization:' || id::text FROM new_rows
      UNION SELECT 'org:' || id::text FROM old_rows
      UNION SELECT 'org:' || id::text FROM new_rows
      UNION SELECT 'partner:' || partner_id::text FROM old_rows
      UNION SELECT 'partner:' || partner_id::text FROM new_rows
    ) keys;
  ELSIF TG_TABLE_NAME = 'sites' THEN
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'target:site:' || id::text AS identity FROM old_rows
      UNION SELECT 'target:site:' || id::text FROM new_rows
      UNION SELECT 'org:' || org_id::text FROM old_rows
      UNION SELECT 'org:' || org_id::text FROM new_rows
      UNION SELECT 'partner:' || organization.partner_id::text
        FROM public.organizations organization
        WHERE organization.id IN (
          SELECT org_id FROM old_rows UNION SELECT org_id FROM new_rows
        )
    ) keys;
  ELSIF TG_TABLE_NAME = 'device_groups' THEN
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'target:device_group:' || id::text AS identity FROM old_rows
      UNION SELECT 'target:device_group:' || id::text FROM new_rows
      UNION SELECT 'org:' || org_id::text FROM old_rows
      UNION SELECT 'org:' || org_id::text FROM new_rows
      UNION SELECT 'partner:' || organization.partner_id::text
        FROM public.organizations organization
        WHERE organization.id IN (
          SELECT org_id FROM old_rows UNION SELECT org_id FROM new_rows
        )
    ) keys;
  ELSE
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'target:device:' || id::text AS identity FROM old_rows
      UNION SELECT 'target:device:' || id::text FROM new_rows
      UNION SELECT 'org:' || org_id::text FROM old_rows
      UNION SELECT 'org:' || org_id::text FROM new_rows
      UNION SELECT 'partner:' || organization.partner_id::text
        FROM public.organizations organization
        WHERE organization.id IN (
          SELECT org_id FROM old_rows UNION SELECT org_id FROM new_rows
        )
    ) keys;
  END IF;

  FOR lock_key IN
    SELECT DISTINCT hashtext(identity) FROM unnest(identities) identity
    ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000301, lock_key);
  END LOOP;

  -- Re-query after the lock.  Under READ COMMITTED this includes an assignment
  -- that won the identity lock and committed while this statement waited.
  IF TG_TABLE_NAME = 'configuration_policies' THEN
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.config_policy_id IN (
      SELECT id FROM old_rows UNION SELECT id FROM new_rows
    );
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    SELECT COALESCE(array_agg(DISTINCT to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    JOIN public.configuration_policies policy ON policy.id = assignment.config_policy_id
    WHERE policy.org_id IN (SELECT id FROM old_rows UNION SELECT id FROM new_rows)
       OR (assignment.level = 'organization' AND assignment.target_id IN (
         SELECT id FROM old_rows UNION SELECT id FROM new_rows))
       OR (assignment.level = 'site' AND EXISTS (
         SELECT 1 FROM public.sites site WHERE site.id = assignment.target_id
           AND site.org_id IN (SELECT id FROM old_rows UNION SELECT id FROM new_rows)))
       OR (assignment.level = 'device_group' AND EXISTS (
         SELECT 1 FROM public.device_groups device_group
         WHERE device_group.id = assignment.target_id
           AND device_group.org_id IN (SELECT id FROM old_rows UNION SELECT id FROM new_rows)))
       OR (assignment.level = 'device' AND EXISTS (
         SELECT 1 FROM public.devices device WHERE device.id = assignment.target_id
           AND device.org_id IN (SELECT id FROM old_rows UNION SELECT id FROM new_rows)));
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.target_id IN (
      SELECT id FROM old_rows UNION SELECT id FROM new_rows
    ) AND assignment.level::text = CASE TG_TABLE_NAME
      WHEN 'sites' THEN 'site'
      WHEN 'device_groups' THEN 'device_group'
      WHEN 'devices' THEN 'device'
    END;
  END IF;
  PERFORM public.breeze_validate_config_policy_assignment_new_rows(values);
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  identities text[] := ARRAY[]::text[];
  values jsonb[] := ARRAY[]::jsonb[];
  lock_key integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);
  IF TG_TABLE_NAME = 'configuration_policies' THEN
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'policy:' || id::text AS identity FROM old_rows
      UNION SELECT 'org:' || org_id::text FROM old_rows WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM old_rows WHERE partner_id IS NOT NULL
    ) keys;
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'target:organization:' || id::text AS identity FROM old_rows
      UNION SELECT 'org:' || id::text FROM old_rows
      UNION SELECT 'partner:' || partner_id::text FROM old_rows
    ) keys;
  ELSE
    SELECT COALESCE(array_agg(identity), ARRAY[]::text[]) INTO identities FROM (
      SELECT 'target:' || CASE TG_TABLE_NAME
        WHEN 'sites' THEN 'site'
        WHEN 'device_groups' THEN 'device_group'
        WHEN 'devices' THEN 'device'
      END || ':' || id::text AS identity FROM old_rows
      UNION SELECT 'org:' || org_id::text FROM old_rows
      UNION SELECT 'partner:' || organization.partner_id::text
        FROM public.organizations organization
        WHERE organization.id IN (SELECT org_id FROM old_rows)
    ) keys;
  END IF;

  FOR lock_key IN
    SELECT DISTINCT hashtext(identity) FROM unnest(identities) identity
    ORDER BY hashtext(identity)
  LOOP
    PERFORM pg_advisory_xact_lock(1000301, lock_key);
  END LOOP;

  IF TG_TABLE_NAME = 'configuration_policies' THEN
    -- The FK cascade has already removed these assignments.
    values := ARRAY[]::jsonb[];
  ELSIF TG_TABLE_NAME = 'organizations' THEN
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.level = 'organization'
      AND assignment.target_id IN (SELECT id FROM old_rows);
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.target_id IN (SELECT id FROM old_rows)
      AND assignment.level::text = CASE TG_TABLE_NAME
        WHEN 'sites' THEN 'site'
        WHEN 'device_groups' THEN 'device_group'
        WHEN 'devices' THEN 'device'
      END;
  END IF;
  PERFORM public.breeze_validate_config_policy_assignment_new_rows(values);
  RETURN NULL;
END;
$$;

-- Remove both generations of row-at-a-time reverse enforcement.
DROP TRIGGER IF EXISTS aa_config_policy_assignment_owner_serialize_update ON public.configuration_policies;
DROP TRIGGER IF EXISTS aa_config_policy_assignment_owner_serialize_delete ON public.configuration_policies;
DROP TRIGGER IF EXISTS a_config_policy_assignment_policy_owner_update ON public.configuration_policies;

DROP TRIGGER IF EXISTS aa_config_policy_assignment_org_serialize_update ON public.organizations;
DROP TRIGGER IF EXISTS aa_config_policy_assignment_org_serialize_delete ON public.organizations;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_update ON public.organizations;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_delete ON public.organizations;

DROP TRIGGER IF EXISTS aa_config_policy_assignment_site_serialize_update ON public.sites;
DROP TRIGGER IF EXISTS aa_config_policy_assignment_site_serialize_delete ON public.sites;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_update ON public.sites;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_delete ON public.sites;

DROP TRIGGER IF EXISTS aa_config_policy_assignment_group_serialize_update ON public.device_groups;
DROP TRIGGER IF EXISTS aa_config_policy_assignment_group_serialize_delete ON public.device_groups;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_update ON public.device_groups;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_delete ON public.device_groups;

DROP TRIGGER IF EXISTS aa_config_policy_assignment_device_serialize_update ON public.devices;
DROP TRIGGER IF EXISTS aa_config_policy_assignment_device_serialize_delete ON public.devices;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_update ON public.devices;
DROP TRIGGER IF EXISTS a_config_policy_assignment_target_delete ON public.devices;

DROP TRIGGER IF EXISTS a_config_policy_assignment_integrity_insert ON public.config_policy_assignments;
CREATE TRIGGER a_config_policy_assignment_integrity_insert
AFTER INSERT ON public.config_policy_assignments
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_integrity();
DROP TRIGGER IF EXISTS a_config_policy_assignment_integrity_update ON public.config_policy_assignments;
CREATE TRIGGER a_config_policy_assignment_integrity_update
AFTER UPDATE ON public.config_policy_assignments
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_integrity();
DROP TRIGGER IF EXISTS a_config_policy_assignment_integrity_delete ON public.config_policy_assignments;
CREATE TRIGGER a_config_policy_assignment_integrity_delete
AFTER DELETE ON public.config_policy_assignments
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_enforce_config_policy_assignment_integrity();

DROP TRIGGER IF EXISTS ab_config_policy_assignment_policy_owner_update ON public.configuration_policies;
CREATE TRIGGER ab_config_policy_assignment_policy_owner_update
AFTER UPDATE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates();
DROP TRIGGER IF EXISTS ab_config_policy_assignment_policy_owner_delete ON public.configuration_policies;
CREATE TRIGGER ab_config_policy_assignment_policy_owner_delete
AFTER DELETE ON public.configuration_policies
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes();

DROP TRIGGER IF EXISTS ab_config_policy_assignment_org_owner_update ON public.organizations;
CREATE TRIGGER ab_config_policy_assignment_org_owner_update
AFTER UPDATE ON public.organizations
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates();
DROP TRIGGER IF EXISTS ab_config_policy_assignment_org_owner_delete ON public.organizations;
CREATE TRIGGER ab_config_policy_assignment_org_owner_delete
AFTER DELETE ON public.organizations
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes();

DROP TRIGGER IF EXISTS ab_config_policy_assignment_site_owner_update ON public.sites;
CREATE TRIGGER ab_config_policy_assignment_site_owner_update
AFTER UPDATE ON public.sites
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates();
DROP TRIGGER IF EXISTS ab_config_policy_assignment_site_owner_delete ON public.sites;
CREATE TRIGGER ab_config_policy_assignment_site_owner_delete
AFTER DELETE ON public.sites
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes();

DROP TRIGGER IF EXISTS ab_config_policy_assignment_group_owner_update ON public.device_groups;
CREATE TRIGGER ab_config_policy_assignment_group_owner_update
AFTER UPDATE ON public.device_groups
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates();
DROP TRIGGER IF EXISTS ab_config_policy_assignment_group_owner_delete ON public.device_groups;
CREATE TRIGGER ab_config_policy_assignment_group_owner_delete
AFTER DELETE ON public.device_groups
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes();

DROP TRIGGER IF EXISTS ab_config_policy_assignment_device_owner_update ON public.devices;
CREATE TRIGGER ab_config_policy_assignment_device_owner_update
AFTER UPDATE ON public.devices
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates();
DROP TRIGGER IF EXISTS ab_config_policy_assignment_device_owner_delete ON public.devices;
CREATE TRIGGER ab_config_policy_assignment_device_owner_delete
AFTER DELETE ON public.devices
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
EXECUTE FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes();

REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_enforce_config_policy_assignment_integrity() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_deletes() FROM breeze_app;
  END IF;
END $$;

-- Remove the unused 07-29 entry points that accepted caller-supplied owner
-- arrays.  All lock identities now come only from trigger transition tables.
DROP FUNCTION IF EXISTS public.breeze_enforce_config_policy_assignment_insert();
DROP FUNCTION IF EXISTS public.breeze_enforce_config_policy_assignment_update();
DROP FUNCTION IF EXISTS public.breeze_enforce_config_policy_assignment_delete();
DROP FUNCTION IF EXISTS public.breeze_serialize_config_policy_assignment_owner_change();
DROP FUNCTION IF EXISTS public.breeze_lock_config_policy_assignment_rows(jsonb[], uuid[], uuid[]);
