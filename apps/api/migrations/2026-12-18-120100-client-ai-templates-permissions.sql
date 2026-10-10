-- client_ai_templates:read / client_ai_templates:write — dedicated permissions
-- for the AI for Office prompt-template manager (list, create, edit and
-- remove under /client-ai/admin/templates). Those routes were gated on the generic
-- organizations:read / organizations:write grants. Template writes now also
-- require MFA when the caller's MFA policy requires it (requireMfa() at the
-- route, not here).
--
-- Grants, matching SYSTEM_ROLES in apps/api/src/db/seed.ts:
--
--   1. Existing-grant mapping. Every role holding organizations:read gets
--      client_ai_templates:read; every role holding organizations:write gets
--      client_ai_templates:write. Matching is on the EXISTING GRANT, never on
--      a role's name, so it covers system role templates, per-partner
--      is_system clones AND custom (is_system = FALSE) roles alike — the same
--      approach as 2026-10-27-100100-quotes-accept-permission.sql. This step
--      only re-issues access a role already had through the organizations
--      grants. Partners who want template access narrower than the
--      organizations grant revoke it afterwards in the role editor.
--
--   2. Built-in Org Admin gets both read and write. This is a deliberate
--      widening: Org Admin holds neither organizations grant, so it had no
--      template access before. Matched on
--      `r.name = 'Org Admin' AND r.scope = 'organization' AND
--      r.is_system = TRUE` with no `partner_id IS NULL` clause, as in
--      2026-10-15-150200-pam-dedicated-permissions.sql: per-partner is_system
--      clones exist, and custom roles are always is_system = FALSE, so a custom
--      role merely named "Org Admin" gets nothing from this step. Partner-wide
--      templates still require partner scope with org_access = 'all'
--      (canManagePartnerWidePolicies), so an org-scoped Org Admin reaches only
--      its own organization's templates.
--
-- Wildcards need no back-fill: grant matching is per-axis
-- (services/permissionMatching.ts), so Partner Admin's '*:*' row already
-- satisfies both permissions at runtime. A defensive organizations:* lookup is
-- included in step 1 and is expected to be NULL on every real database.
--
-- permissions has NO UNIQUE (resource, action), so the catalog inserts use an
-- explicit existence check. role_permissions is PRIMARY KEY
-- (role_id, permission_id); the grants use NOT EXISTS so re-applying is a
-- no-op. No inner transaction.
--
-- roles / role_permissions / permissions are FORCE RLS: elect system scope
-- first or the writes below match zero rows silently (migrationRlsScope.test).
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. Permission rows
-- ============================================
-- Descriptions are normative and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts.
DO $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'client_ai_templates' AND action = 'read'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('client_ai_templates', 'read', 'View AI for Office prompt templates');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded client_ai_templates:read permission row';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'client_ai_templates' AND action = 'write'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('client_ai_templates', 'write', 'Create, edit, and delete AI for Office prompt templates');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded client_ai_templates:write permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. Grants
-- ============================================
DO $$
DECLARE
  n integer;
  v_tpl_read_id uuid;
  v_tpl_write_id uuid;
  v_orgs_read_id uuid;
  v_orgs_write_id uuid;
  v_orgs_any_id uuid;
BEGIN
  -- Scalar lookups (not JOINs), so this stays correct even if a duplicate
  -- permissions row were ever present — always exactly one id.
  SELECT id INTO v_tpl_read_id FROM permissions
  WHERE resource = 'client_ai_templates' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_tpl_write_id FROM permissions
  WHERE resource = 'client_ai_templates' AND action = 'write' ORDER BY id LIMIT 1;

  SELECT id INTO v_orgs_read_id FROM permissions
  WHERE resource = 'organizations' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_orgs_write_id FROM permissions
  WHERE resource = 'organizations' AND action = 'write' ORDER BY id LIMIT 1;

  SELECT id INTO v_orgs_any_id FROM permissions
  WHERE resource = 'organizations' AND action = '*' ORDER BY id LIMIT 1;

  IF v_orgs_any_id IS NOT NULL THEN
    RAISE WARNING 'unexpected organizations:* permission row present — including it in the client_ai_templates back-fill';
  END IF;

  -- 2a. organizations:read holders → client_ai_templates:read
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_tpl_read_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_orgs_read_id, v_orgs_any_id)
    AND v_tpl_read_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_tpl_read_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted client_ai_templates:read to % role(s) holding organizations:read', n;

  -- 2b. organizations:write holders → client_ai_templates:write
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_tpl_write_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_orgs_write_id, v_orgs_any_id)
    AND v_tpl_write_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_tpl_write_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'granted client_ai_templates:write to % role(s) holding organizations:write', n;

  -- 2c. Built-in Org Admin → read + write
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (
    SELECT v_tpl_read_id AS id
    UNION ALL
    SELECT v_tpl_write_id
  ) p
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND p.id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = r.id AND existing.permission_id = p.id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'granted client_ai_templates read/write to built-in Org Admin role(s) (% row(s))', n;
END $$;
