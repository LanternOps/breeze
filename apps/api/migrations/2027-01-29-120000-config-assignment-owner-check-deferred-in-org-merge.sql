-- #12490: org merge of an organization that owns a configuration policy
-- applied inside itself (to the organization, a site, a device group or a
-- device) failed with 23503 config_policy_assignments_target_owner_fk.
--
-- breeze_serialize_config_policy_assignment_owner_updates() is a statement
-- trigger, so it validates at the end of every statement and SET CONSTRAINTS
-- ALL DEFERRED cannot hold it back. The merge walk moves configuration_policies
-- and each target table (sites, device_groups, devices) in separate statements,
-- so whichever runs first leaves an org-owned policy and its target in
-- different organizations. No walk order fixes that: both sides must move.
--
-- The fix defers the check inside a merge; it does not skip it:
-- 1. breeze_serialize_config_policy_assignment_owner_updates(), copied verbatim
--    from 2027-01-12-200200-config-assignment-partner-device-group-targets.sql,
--    plus one gate before the final validation: when breeze.org_merge = 'on'
--    (only services/orgMerge.ts sets it; orgMergeGucContract.test.ts pins
--    that for the API sources) and
--    the statement moved owners on configuration_policies, sites, device_groups
--    or devices without changing any row id, it still takes every advisory
--    lock but returns before validating. organizations stays ungated.
-- 2. breeze_check_config_policy_assignment_owner_row() and the constraint
--    triggers config_policy_assignment_owner_row_check on those four tables,
--    DEFERRABLE INITIALLY DEFERRED, one event per row whose owner changed. Each
--    re-validates every assignment of its row at COMMIT, whatever the GUC says.
--    Inside a merge that is after the post-pass has re-pointed
--    organization-level assignments, and after the serializer took its locks.
--    Outside a merge it repeats the serializer's immediate check at commit,
--    so behaviour there is unchanged (device move-org still refuses an
--    assignment of the source org's policy, #12491).
-- Precedent: configuration_policies_parent_guard is a deferrable constraint
-- trigger for the same merge reason (2026-10-12-100000-config-policy-inheritance.sql).
--
-- CREATE OR REPLACE shared function: merge this file one at a time with any
-- other PR that redefines breeze_serialize_config_policy_assignment_owner_updates().
-- No rows are written; idempotent.

SELECT set_config('breeze.scope', 'system', true);

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
  ELSIF TG_TABLE_NAME = 'device_groups' THEN
    IF NOT EXISTS (
      (SELECT id, org_id, partner_id FROM old_rows
        EXCEPT SELECT id, org_id, partner_id FROM new_rows)
      UNION ALL
      (SELECT id, org_id, partner_id FROM new_rows
        EXCEPT SELECT id, org_id, partner_id FROM old_rows)
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
      UNION SELECT 'org:' || org_id::text FROM old_rows WHERE org_id IS NOT NULL
      UNION SELECT 'org:' || org_id::text FROM new_rows WHERE org_id IS NOT NULL
      UNION SELECT 'partner:' || organization.partner_id::text
        FROM public.organizations organization
        WHERE organization.id IN (
          SELECT org_id FROM old_rows UNION SELECT org_id FROM new_rows
        )
      UNION SELECT 'partner:' || partner_id::text FROM old_rows WHERE partner_id IS NOT NULL
      UNION SELECT 'partner:' || partner_id::text FROM new_rows WHERE partner_id IS NOT NULL
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

  -- #12490: inside an org merge, an owner move on these four tables defers its
  -- validation to the config_policy_assignment_owner_row_check constraint
  -- triggers (INITIALLY DEFERRED), which re-check every assignment of each
  -- moved row at COMMIT, while the locks above are still held. The merge moves
  -- a policy and its targets in separate statements, so the state at the end
  -- of each one is necessarily mixed. A statement that changes any row id is
  -- not deferred: the row check reads assignments by NEW.id and would miss
  -- those of the old id, so it keeps the immediate validation below.
  IF current_setting('breeze.org_merge', true) = 'on'
     AND TG_TABLE_NAME IN ('configuration_policies', 'sites', 'device_groups', 'devices')
     AND NOT EXISTS (
       (SELECT id FROM old_rows EXCEPT SELECT id FROM new_rows)
       UNION ALL
       (SELECT id FROM new_rows EXCEPT SELECT id FROM old_rows)
     ) THEN
    PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
    PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
    PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
    RETURN NULL;
  END IF;

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

CREATE OR REPLACE FUNCTION public.breeze_check_config_policy_assignment_owner_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Same in-body elevation and restore as the serializer: breeze.* is held for
  -- the whole transaction, so a leaked 'system' scope would be an RLS hole.
  _prev_scope text := current_setting('breeze.scope', true);
  _prev_org_ids text := current_setting('breeze.accessible_org_ids', true);
  _prev_partner_ids text := current_setting('breeze.accessible_partner_ids', true);
  values jsonb[] := ARRAY[]::jsonb[];
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  PERFORM set_config('breeze.accessible_org_ids', '', true);
  PERFORM set_config('breeze.accessible_partner_ids', '', true);
  -- Re-read the assignments now (usually at COMMIT), not from the row event:
  -- this sees the final owners and any assignment re-pointed after the move.
  IF TG_TABLE_NAME = 'configuration_policies' THEN
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.config_policy_id = NEW.id;
  ELSE
    SELECT COALESCE(array_agg(to_jsonb(assignment)), ARRAY[]::jsonb[]) INTO values
    FROM public.config_policy_assignments assignment
    WHERE assignment.target_id = NEW.id
      AND assignment.level::text = CASE TG_TABLE_NAME
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

REVOKE ALL ON FUNCTION public.breeze_check_config_policy_assignment_owner_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE ALL ON FUNCTION public.breeze_check_config_policy_assignment_owner_row() FROM breeze_app;
    REVOKE ALL ON FUNCTION public.breeze_serialize_config_policy_assignment_owner_updates() FROM breeze_app;
  END IF;
END $$;

-- UPDATE OF + WHEN: a heartbeat or any update that leaves the owner alone
-- queues no event. INITIALLY DEFERRED so the check waits for COMMIT even when
-- a caller sets breeze.org_merge without SET CONSTRAINTS ALL DEFERRED.
DROP TRIGGER IF EXISTS config_policy_assignment_owner_row_check ON public.configuration_policies;
CREATE CONSTRAINT TRIGGER config_policy_assignment_owner_row_check
  AFTER UPDATE OF org_id, partner_id ON public.configuration_policies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.partner_id IS DISTINCT FROM NEW.partner_id)
  EXECUTE FUNCTION public.breeze_check_config_policy_assignment_owner_row();

DROP TRIGGER IF EXISTS config_policy_assignment_owner_row_check ON public.sites;
CREATE CONSTRAINT TRIGGER config_policy_assignment_owner_row_check
  AFTER UPDATE OF org_id ON public.sites
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION public.breeze_check_config_policy_assignment_owner_row();

DROP TRIGGER IF EXISTS config_policy_assignment_owner_row_check ON public.device_groups;
CREATE CONSTRAINT TRIGGER config_policy_assignment_owner_row_check
  AFTER UPDATE OF org_id, partner_id ON public.device_groups
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.partner_id IS DISTINCT FROM NEW.partner_id)
  EXECUTE FUNCTION public.breeze_check_config_policy_assignment_owner_row();

DROP TRIGGER IF EXISTS config_policy_assignment_owner_row_check ON public.devices;
CREATE CONSTRAINT TRIGGER config_policy_assignment_owner_row_check
  AFTER UPDATE OF org_id ON public.devices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION public.breeze_check_config_policy_assignment_owner_row();
