-- BE-16 enhancement P1: introduce vulnerabilities:accept_risk and grant it to the
-- global Org Admin system role + two new Security Approver roles. This gates
-- accept-risk/reopen above devices:write so a default technician can no longer
-- unilaterally waive a finding.
--
-- Operates ONLY on global system role rows (partner_id IS NULL, is_system = TRUE).
-- Per-partner cloned Partner Admin rows carry *:* and keep everything; custom
-- roles are untouched. NO backfill to existing devices:write holders — that would
-- re-open the hole. On a fresh DB this runs before seed.ts and both converge.
-- Idempotent.

-- 1. Ensure the permission catalog row exists exactly once (permissions has no
--    unique(resource,action), so guard with WHERE NOT EXISTS).
INSERT INTO permissions (resource, action, description)
SELECT 'vulnerabilities', 'accept_risk', 'Waive (accept risk) and reopen vulnerability findings'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'vulnerabilities' AND action = 'accept_risk'
);

-- 2. Grant it to the global Org Admin system role.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (SELECT id FROM permissions WHERE resource = 'vulnerabilities' AND action = 'accept_risk' LIMIT 1) p
  WHERE r.partner_id IS NULL AND r.scope = 'organization'
    AND r.name = 'Org Admin' AND r.is_system = TRUE
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'vuln-risk-accept: granted accept_risk to % Org Admin role(s)', n;
END $$;

-- 3. Create the two new global system roles (NOT EXISTS guards).
INSERT INTO roles (partner_id, scope, name, description, is_system)
SELECT NULL, 'organization', 'Security Approver',
       'Review and waive (accept risk) / reopen vulnerability findings', TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM roles
  WHERE partner_id IS NULL AND scope = 'organization'
    AND name = 'Security Approver' AND is_system = TRUE
);

INSERT INTO roles (partner_id, scope, name, description, is_system)
SELECT NULL, 'partner', 'Partner Security Approver',
       'Review and waive (accept risk) / reopen vulnerability findings across assigned organizations', TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM roles
  WHERE partner_id IS NULL AND scope = 'partner'
    AND name = 'Partner Security Approver' AND is_system = TRUE
);

-- 4a. Grant the org-scope Security Approver its perm set (devices:read + accept_risk).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
       (p.resource = 'devices'         AND p.action = 'read')
    OR (p.resource = 'vulnerabilities' AND p.action = 'accept_risk')
)
WHERE r.partner_id IS NULL AND r.scope = 'organization'
  AND r.name = 'Security Approver' AND r.is_system = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id
  );

-- 4b. Grant the partner-scope Partner Security Approver its perm set
--     (devices:read + organizations:read + accept_risk).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
       (p.resource = 'devices'         AND p.action = 'read')
    OR (p.resource = 'organizations'   AND p.action = 'read')
    OR (p.resource = 'vulnerabilities' AND p.action = 'accept_risk')
)
WHERE r.partner_id IS NULL AND r.scope = 'partner'
  AND r.name = 'Partner Security Approver' AND r.is_system = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id
  );
