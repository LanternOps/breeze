-- E2E fixture for tests/config-policy-create.spec.ts (#12471).
--
-- Two users in the seeded admin's partner, both signing in with the admin's
-- password (the hash is copied, so no hashing happens here):
--   - cp-limited@breeze.local: a Partner Admin with access to ONE organization
--     (org_access 'selected'), so a new policy defaults to that organization
--     and MSP-managed is never offered.
--   - cp-org@breeze.local: an Org Admin of that same organization (an
--     organization-scope user).
-- The organization is the partner's first organization by name.
--
-- Idempotent: fixed emails and ids; re-running refreshes the rows.
-- The organization id is emitted on stdout. Run with -v ON_ERROR_STOP=1.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  v_limited   uuid := 'c0000000-0000-4000-8000-0000000000c1';
  v_org_user  uuid := 'c0000000-0000-4000-8000-0000000000c2';
  v_partner   uuid;
  v_org       uuid;
  v_hash      text;
  v_partner_role uuid;
  v_org_role  uuid;
BEGIN
  SELECT u.password_hash, u.partner_id INTO v_hash, v_partner FROM users u WHERE u.email = 'admin@breeze.local';
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local not found or has no password — is the stack seeded?';
  END IF;

  SELECT id INTO v_org FROM organizations WHERE partner_id = v_partner AND status = 'active' ORDER BY name, id LIMIT 1;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'seed: the admin''s partner has no active organization';
  END IF;

  SELECT id INTO v_partner_role FROM roles
   WHERE name = 'Partner Admin' AND is_system AND partner_id IS NULL AND org_id IS NULL LIMIT 1;
  SELECT id INTO v_org_role FROM roles
   WHERE name = 'Org Admin' AND is_system AND partner_id IS NULL AND org_id IS NULL LIMIT 1;
  IF v_partner_role IS NULL OR v_org_role IS NULL THEN
    RAISE EXCEPTION 'seed: system Partner Admin / Org Admin role not found';
  END IF;

  INSERT INTO users (id, partner_id, org_id, email, name, password_hash, status, email_verified_at)
  VALUES (v_limited, v_partner, NULL, 'cp-limited@breeze.local', 'E2E Limited Partner Tech', v_hash, 'active', NOW())
  ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active';
  DELETE FROM partner_users WHERE user_id = v_limited;
  INSERT INTO partner_users (partner_id, user_id, role_id, org_access, org_ids)
  VALUES (v_partner, v_limited, v_partner_role, 'selected', ARRAY[v_org]);

  INSERT INTO users (id, partner_id, org_id, email, name, password_hash, status, email_verified_at)
  VALUES (v_org_user, v_partner, v_org, 'cp-org@breeze.local', 'E2E Org Admin', v_hash, 'active', NOW())
  ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active', org_id = EXCLUDED.org_id;
  IF NOT EXISTS (SELECT 1 FROM organization_users WHERE org_id = v_org AND user_id = v_org_user) THEN
    INSERT INTO organization_users (org_id, user_id, role_id) VALUES (v_org, v_org_user, v_org_role);
  END IF;
END $$;

SELECT 'ORG_ID=' || o.id FROM organizations o
  JOIN users u ON u.partner_id = o.partner_id
 WHERE u.email = 'admin@breeze.local' AND o.status = 'active'
 ORDER BY o.name, o.id LIMIT 1;
