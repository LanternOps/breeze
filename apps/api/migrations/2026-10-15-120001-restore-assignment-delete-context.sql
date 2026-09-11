-- The assignment-owner DELETE statement trigger enters system scope for
-- integrity checks. Restore the exact request context before returning so
-- later statements in the same transaction remain tenant-scoped.
-- CREATE OR REPLACE preserves the existing function owner and ACL.
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
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  PERFORM set_config('breeze.accessible_org_ids', COALESCE(_prev_org_ids, ''), true);
  PERFORM set_config('breeze.accessible_partner_ids', COALESCE(_prev_partner_ids, ''), true);
  RETURN NULL;
END;
$$;
