-- Wave 3: durable live OAuth and event authorization state.
--
-- Expansion-only and safe for preceding API instances:
--   * users.permissions_epoch starts at a stable zero;
--   * OAuth revocation retry work is user-scoped with an explicit system
--     branch for the bounded background worker;
--   * database triggers advance permission authority in the same transaction
--     as membership, access, role assignment, and role-permission mutations.
--
-- Idempotent: ADD COLUMN / CREATE TABLE / CREATE INDEX use IF NOT EXISTS,
-- policies and triggers are dropped then recreated, and functions use
-- CREATE OR REPLACE. autoMigrate supplies the outer transaction.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permissions_epoch bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS oauth_revocation_retries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marker_type varchar(16) NOT NULL,
  marker_id varchar(255) NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error_code varchar(64) NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_revocation_retries_due_idx
  ON oauth_revocation_retries(completed_at, next_attempt_at);

CREATE INDEX IF NOT EXISTS oauth_revocation_retries_user_idx
  ON oauth_revocation_retries(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_revocation_retries_incomplete_marker_uq
  ON oauth_revocation_retries(marker_type, marker_id)
  WHERE completed_at IS NULL;

ALTER TABLE oauth_revocation_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_revocation_retries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oauth_revocation_retries_user_scope ON oauth_revocation_retries;
CREATE POLICY oauth_revocation_retries_user_scope
  ON oauth_revocation_retries
  FOR ALL
  TO breeze_app
  USING (
    user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'
  )
  WITH CHECK (
    user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'
  );

CREATE OR REPLACE FUNCTION breeze_bump_organization_user_permissions_epoch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users
    SET permissions_epoch = permissions_epoch + 1
    WHERE id = NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users
    SET permissions_epoch = permissions_epoch + 1
    WHERE id = OLD.user_id;
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.role_id IS DISTINCT FROM NEW.role_id
     OR OLD.site_ids IS DISTINCT FROM NEW.site_ids THEN
    UPDATE users
    SET permissions_epoch = permissions_epoch + 1
    WHERE id IN (OLD.user_id, NEW.user_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_organization_users_permissions_epoch
  ON organization_users;
CREATE TRIGGER breeze_organization_users_permissions_epoch
AFTER INSERT OR DELETE OR UPDATE OF user_id, role_id, site_ids
ON organization_users
FOR EACH ROW
EXECUTE FUNCTION breeze_bump_organization_user_permissions_epoch();

CREATE OR REPLACE FUNCTION breeze_bump_partner_user_permissions_epoch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users
    SET permissions_epoch = permissions_epoch + 1
    WHERE id = NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE users
    SET permissions_epoch = permissions_epoch + 1
    WHERE id = OLD.user_id;
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.role_id IS DISTINCT FROM NEW.role_id
     OR OLD.org_access IS DISTINCT FROM NEW.org_access
     OR OLD.org_ids IS DISTINCT FROM NEW.org_ids THEN
    UPDATE users
    SET permissions_epoch = permissions_epoch + 1
    WHERE id IN (OLD.user_id, NEW.user_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_partner_users_permissions_epoch
  ON partner_users;
CREATE TRIGGER breeze_partner_users_permissions_epoch
AFTER INSERT OR DELETE OR UPDATE OF user_id, role_id, org_access, org_ids
ON partner_users
FOR EACH ROW
EXECUTE FUNCTION breeze_bump_partner_user_permissions_epoch();

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

  UPDATE users
  SET permissions_epoch = permissions_epoch + 1
  WHERE id IN (
    SELECT ou.user_id
    FROM organization_users ou
    WHERE ou.role_id IN (old_role_id, new_role_id)
    UNION
    SELECT pu.user_id
    FROM partner_users pu
    WHERE pu.role_id IN (old_role_id, new_role_id)
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_role_permissions_permissions_epoch
  ON role_permissions;
CREATE TRIGGER breeze_role_permissions_permissions_epoch
AFTER INSERT OR UPDATE OR DELETE
ON role_permissions
FOR EACH ROW
EXECUTE FUNCTION breeze_bump_role_permission_users_epoch();

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

  UPDATE users
  SET permissions_epoch = permissions_epoch + 1
  WHERE id IN (
    SELECT ou.user_id
    FROM organization_users ou
    WHERE ou.role_id = NEW.id
    UNION
    SELECT pu.user_id
    FROM partner_users pu
    WHERE pu.role_id = NEW.id
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS breeze_roles_permissions_epoch
  ON roles;
CREATE TRIGGER breeze_roles_permissions_epoch
AFTER UPDATE OF partner_id, org_id, parent_role_id, scope, is_system, force_mfa
ON roles
FOR EACH ROW
EXECUTE FUNCTION breeze_bump_role_definition_users_epoch();
