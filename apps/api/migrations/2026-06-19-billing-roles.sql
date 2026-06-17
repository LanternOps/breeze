-- 2026-06-19-billing-roles.sql
-- Dedicated partner-scope billing roles + tighten over-broad grants.
--
-- Context: catalog/invoices/contracts permissions previously rode on the
-- Partner Technician role (the feature backfill migrations granted them because
-- Technician holds tickets:write), and catalog:read sat on Partner Viewer. This
-- introduces two dedicated billing roles and revokes billing from Technician and
-- Viewer, so billing access lives ONLY in Partner Admin + the new roles.
--
-- Operates ONLY on the global system role rows (partner_id IS NULL,
-- is_system = TRUE). Per-partner cloned Partner Admin rows (which carry the *:*
-- wildcard, so they keep everything) and partner-authored custom roles are
-- untouched.
--
-- Idempotent: NOT EXISTS guards on every insert; the DELETEs are naturally
-- repeatable (re-running removes nothing once the grants are gone). On a fresh
-- DB this runs before seed.ts, so the role inserts here and the authoritative
-- definitions in seed.ts converge on the same end state.

-- 1. Ensure the two new global partner-scope system roles exist.
INSERT INTO roles (partner_id, scope, name, description, is_system)
SELECT NULL, 'partner', 'Partner Billing',
       'Full access to product catalog, invoices, and contracts', TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM roles
  WHERE partner_id IS NULL AND scope = 'partner'
    AND name = 'Partner Billing' AND is_system = TRUE
);

INSERT INTO roles (partner_id, scope, name, description, is_system)
SELECT NULL, 'partner', 'Partner Billing Viewer',
       'Read-only access to product catalog, invoices, and contracts', TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM roles
  WHERE partner_id IS NULL AND scope = 'partner'
    AND name = 'Partner Billing Viewer' AND is_system = TRUE
);

-- 2a. Grant Partner Billing every catalog/invoices/contracts permission.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.resource IN ('catalog', 'invoices', 'contracts')
WHERE r.partner_id IS NULL AND r.scope = 'partner'
  AND r.name = 'Partner Billing' AND r.is_system = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id
  );

-- 2b. Grant Partner Billing Viewer the read-only billing set
--     (catalog:read, invoices:read, invoices:export, contracts:read).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
       (p.resource = 'catalog'   AND p.action = 'read')
    OR (p.resource = 'invoices'  AND p.action IN ('read', 'export'))
    OR (p.resource = 'contracts' AND p.action = 'read')
)
WHERE r.partner_id IS NULL AND r.scope = 'partner'
  AND r.name = 'Partner Billing Viewer' AND r.is_system = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id
  );

-- 3a. Revoke ALL billing permissions from the global Partner Technician role.
--     Row count is logged so the change leaves a forensic trail in PG logs.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM role_permissions rp
  USING roles r, permissions p
  WHERE rp.role_id = r.id AND rp.permission_id = p.id
    AND r.partner_id IS NULL AND r.scope = 'partner'
    AND r.name = 'Partner Technician' AND r.is_system = TRUE
    AND p.resource IN ('catalog', 'invoices', 'contracts');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'billing-roles: revoked % billing permission(s) from Partner Technician', n;
  END IF;
END $$;

-- 3b. Revoke catalog access from the global Partner Viewer role.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM role_permissions rp
  USING roles r, permissions p
  WHERE rp.role_id = r.id AND rp.permission_id = p.id
    AND r.partner_id IS NULL AND r.scope = 'partner'
    AND r.name = 'Partner Viewer' AND r.is_system = TRUE
    AND p.resource = 'catalog';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'billing-roles: revoked % catalog permission(s) from Partner Viewer', n;
  END IF;
END $$;
