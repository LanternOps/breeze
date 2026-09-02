-- #3821 wave 1 follow-up: give AI agent policies their own capability instead
-- of gating them on organizations:write.
--
-- Authoring an agent policy is what will eventually authorize autonomous action
-- on customer machines (wave 4 enables `act` mode). Riding on
-- organizations:write would mean every existing org admin silently acquired
-- agent-authoring authority the day that shipped, without the partner who
-- granted organizations:write ever deciding to hand it over. Splitting it now
-- is cheap; splitting it after a release means re-granting on roles already in
-- the wild. Same reasoning as ai_sessions:read_all (2026-07-11).
--
-- Operates ONLY on the global Org Admin system role row (partner_id IS NULL,
-- is_system = TRUE). Per-partner cloned Partner Admin rows carry *:* and keep
-- everything; custom roles are untouched. Idempotent.

-- 1. Catalog rows, exactly once each (permissions has no unique(resource,action)).
INSERT INTO permissions (resource, action, description)
SELECT 'ai_agents', 'read', 'View AI agent policies'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ai_agents' AND action = 'read'
);

INSERT INTO permissions (resource, action, description)
SELECT 'ai_agents', 'write', 'Create, edit and disable AI agent policies'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ai_agents' AND action = 'write'
);

-- 2. Grant both to the global Org Admin system role. An org admin may tighten
--    their OWN org's policy; creating a partner-wide baseline additionally
--    requires partner scope with org_access='all', enforced in the app layer by
--    canManagePartnerWidePolicies, so this grant cannot reach across orgs.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN (
    SELECT id FROM permissions
    WHERE resource = 'ai_agents' AND action IN ('read', 'write')
  ) p
  WHERE r.partner_id IS NULL AND r.scope = 'organization'
    AND r.name = 'Org Admin' AND r.is_system = TRUE
  ON CONFLICT (role_id, permission_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai-agents-permissions: granted ai_agents:read/write to Org Admin (% row(s))', n;
END $$;
