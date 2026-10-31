-- #9600: custom roles inherit their "Inherit From" parent's permissions at
-- runtime (services/roleInheritance.ts). A change to a role's grants or to its
-- parent link therefore changes the effective permissions of every member of
-- every DESCENDANT role too, not only the role's direct members.
--
-- The permissions_epoch triggers from 2026-08-06-b-live-authorization.sql
-- bumped only the direct members, so a live remote session or event socket
-- of a descendant role's member kept running after its inherited grant was
-- removed. Redefine both trigger functions to bump the members of the role
-- and of all its descendants. The trigger definitions themselves are
-- unchanged.
--
-- The descendant walk is bounded at 8 levels (MAX_ROLE_INHERITANCE_DEPTH in
-- services/roleInheritance.ts — the resolver never follows more ancestors than
-- that) and UNION de-duplication plus the depth bound make it cycle-safe.
--
-- Idempotent: CREATE OR REPLACE only. No rows are written by this file.

CREATE OR REPLACE FUNCTION breeze_bump_role_permission_users_epoch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_role_id uuid;
  new_role_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_role_id := OLD.role_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_role_id := NEW.role_id;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.role_id IS NOT DISTINCT FROM NEW.role_id
     AND OLD.permission_id IS NOT DISTINCT FROM NEW.permission_id
     AND OLD.constraints IS NOT DISTINCT FROM NEW.constraints THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE affected_roles(role_id, depth) AS (
    SELECT seed.role_id, 0
    FROM unnest(ARRAY[old_role_id, new_role_id]) AS seed(role_id)
    WHERE seed.role_id IS NOT NULL
    UNION
    SELECT child.id, affected_roles.depth + 1
    FROM roles child
    JOIN affected_roles ON child.parent_role_id = affected_roles.role_id
    WHERE affected_roles.depth < 8
  )
  UPDATE users
  SET permissions_epoch = permissions_epoch + 1
  WHERE id IN (
    SELECT ou.user_id
    FROM organization_users ou
    WHERE ou.role_id IN (SELECT role_id FROM affected_roles)
    UNION
    SELECT pu.user_id
    FROM partner_users pu
    WHERE pu.role_id IN (SELECT role_id FROM affected_roles)
  );

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION breeze_bump_role_definition_users_epoch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.partner_id IS NOT DISTINCT FROM NEW.partner_id
     AND OLD.org_id IS NOT DISTINCT FROM NEW.org_id
     AND OLD.parent_role_id IS NOT DISTINCT FROM NEW.parent_role_id
     AND OLD.scope IS NOT DISTINCT FROM NEW.scope
     AND OLD.is_system IS NOT DISTINCT FROM NEW.is_system
     AND OLD.force_mfa IS NOT DISTINCT FROM NEW.force_mfa THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE affected_roles(role_id, depth) AS (
    SELECT NEW.id, 0
    UNION
    SELECT child.id, affected_roles.depth + 1
    FROM roles child
    JOIN affected_roles ON child.parent_role_id = affected_roles.role_id
    WHERE affected_roles.depth < 8
  )
  UPDATE users
  SET permissions_epoch = permissions_epoch + 1
  WHERE id IN (
    SELECT ou.user_id
    FROM organization_users ou
    WHERE ou.role_id IN (SELECT role_id FROM affected_roles)
    UNION
    SELECT pu.user_id
    FROM partner_users pu
    WHERE pu.role_id IN (SELECT role_id FROM affected_roles)
  );

  RETURN NULL;
END;
$$;
