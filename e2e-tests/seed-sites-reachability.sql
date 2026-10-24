-- E2E fixture for tests/sites-reachability.spec.ts (#9791 wave E).
--
-- In the Default Partner it creates:
--   * DEVICE_A  — a movable agent device in the Default Organization's Default Site
--   * an org-scoped user (e2e-w06-orgadmin@breeze.local): organization_users row
--     with the system Org Admin role and NO partner_users row, so login resolves
--     to scope 'organization'. Same password as admin@breeze.local (hash copied).
--   * ORG_B / SITE_B / DEVICE_B — a second organization with one device, for the
--     mixed-organization bulk-move disabled-reason check.
--
-- Idempotent: fixed ids; a re-run moves DEVICE_A back to its home site and
-- removes target sites a crashed previous run left behind.
-- Run with -v ON_ERROR_STOP=1. Ids are emitted on stdout as KEY=<uuid>.
--
-- Three separate transactions (one per DO block, each electing system scope):
-- the partner-export triggers require org/partner locks in ascending UUID order
-- and refuse to upgrade a shared lock, so org B, org A and the user must not be
-- written in one transaction.

-- 1. Organization B first (takes the exclusive partner lock before anything else).
SELECT set_config('breeze.scope', 'system', true);
DO $$
DECLARE
  v_partner  uuid;
  v_currency text;
  v_org_b    uuid := 'e2e60000-0000-4000-8000-000000000020';
BEGIN
  SELECT u.partner_id, o.currency_code INTO v_partner, v_currency
    FROM users u JOIN organizations o ON o.partner_id = u.partner_id AND o.name = 'Default Organization'
   WHERE u.email = 'admin@breeze.local' LIMIT 1;
  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local / Default Organization not found — is the stack seeded?';
  END IF;
  INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
  VALUES (v_org_b, v_partner, 'E2E W06 Org B', 'e2e-w06-org-b', 'active', v_currency)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active';
END $$;

-- 2. Organization B's site and device.
SELECT set_config('breeze.scope', 'system', true);
DO $$
DECLARE
  v_org_b  uuid := 'e2e60000-0000-4000-8000-000000000020';
  v_site_b uuid := 'e2e60000-0000-4000-8000-000000000022';
  v_dev_b  uuid := 'e2e60000-0000-4000-8000-000000000021';
BEGIN
  INSERT INTO sites (id, org_id, name, timezone)
  VALUES (v_site_b, v_org_b, 'E2E W06 Site B', 'UTC')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
  INSERT INTO devices (id, org_id, site_id, agent_id, hostname, display_name, os_type, os_version,
                       architecture, agent_version, status, last_seen_at)
  VALUES (v_dev_b, v_org_b, v_site_b, 'e2e-w06-agent-b', 'e2e-w06-orgb.local', 'E2E W06 Org B Device',
          'windows', '11.0.22631', 'amd64', '0.63.0', 'online', NOW())
  ON CONFLICT (id) DO UPDATE SET status = 'online', last_seen_at = NOW(), updated_at = NOW();
END $$;

-- 3. Default organization: movable device, leftover-site cleanup, org-scoped user.
SELECT set_config('breeze.scope', 'system', true);
DO $$
DECLARE
  v_partner uuid;
  v_org_a   uuid;
  v_site_a  uuid;
  v_hash    text;
  v_role    uuid;
  v_user    uuid := 'e2e60000-0000-4000-8000-000000000010';
  v_dev_a   uuid := 'e2e60000-0000-4000-8000-000000000001';
BEGIN
  SELECT password_hash, partner_id INTO v_hash, v_partner FROM users WHERE email = 'admin@breeze.local';
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local not found or has no password — is the stack seeded?';
  END IF;
  SELECT id INTO v_org_a FROM organizations WHERE partner_id = v_partner AND name = 'Default Organization' LIMIT 1;
  IF v_org_a IS NULL THEN
    RAISE EXCEPTION 'seed: Default Organization not found';
  END IF;
  SELECT id INTO v_site_a FROM sites WHERE org_id = v_org_a AND name = 'Default Site' LIMIT 1;
  IF v_site_a IS NULL THEN
    RAISE EXCEPTION 'seed: Default Site not found';
  END IF;
  SELECT id INTO v_role FROM roles
   WHERE name = 'Org Admin' AND is_system AND partner_id IS NULL AND org_id IS NULL LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'seed: system Org Admin role not found';
  END IF;

  -- DEVICE_A: a re-run moves it home; mirror the denormalised site columns.
  INSERT INTO devices (id, org_id, site_id, agent_id, hostname, display_name, os_type, os_version,
                       architecture, agent_version, status, last_seen_at)
  VALUES (v_dev_a, v_org_a, v_site_a, 'e2e-w06-agent-a', 'e2e-w06-movable.local', 'E2E W06 Movable',
          'windows', '11.0.22631', 'amd64', '0.63.0', 'online', NOW())
  ON CONFLICT (id) DO UPDATE SET site_id = v_site_a, status = 'online', last_seen_at = NOW(), updated_at = NOW();
  -- An offline agent in the same org, so "online" is a strict subset of the fleet
  -- and the dashboard Online-tile parity check (E1) cannot pass vacuously.
  INSERT INTO devices (id, org_id, site_id, agent_id, hostname, display_name, os_type, os_version,
                       architecture, agent_version, status, last_seen_at)
  VALUES ('e2e60000-0000-4000-8000-000000000002', v_org_a, v_site_a, 'e2e-w06-agent-off',
          'e2e-w06-offline.local', 'E2E W06 Offline', 'windows', '11.0.22631', 'amd64', '0.63.0',
          'offline', NOW() - INTERVAL '2 days')
  ON CONFLICT (id) DO UPDATE SET site_id = v_site_a, status = 'offline',
    last_seen_at = NOW() - INTERVAL '2 days', updated_at = NOW();
  UPDATE topology_node_bindings SET site_id = v_site_a WHERE device_id = v_dev_a;
  UPDATE elevation_requests SET site_id = v_site_a WHERE device_id = v_dev_a;

  -- Leftover target sites from a crashed run: re-home their devices, then drop them.
  UPDATE devices SET site_id = v_site_a
   WHERE org_id = v_org_a
     AND site_id IN (SELECT id FROM sites WHERE org_id = v_org_a AND name LIKE 'E2E W06 Target%');
  BEGIN
    DELETE FROM sites WHERE org_id = v_org_a AND name LIKE 'E2E W06 Target%';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'seed: leftover E2E W06 Target site still referenced; leaving it';
  END;

  -- Org-scoped user: organization_users only, never partner_users.
  INSERT INTO users (id, partner_id, org_id, email, name, password_hash, status, email_verified_at, setup_completed_at)
  VALUES (v_user, v_partner, v_org_a, 'e2e-w06-orgadmin@breeze.local', 'E2E W06 Org Admin', v_hash,
          'active', NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active',
    email_verified_at = NOW(), setup_completed_at = COALESCE(users.setup_completed_at, NOW());
  DELETE FROM partner_users WHERE user_id = v_user;
  IF NOT EXISTS (SELECT 1 FROM organization_users WHERE org_id = v_org_a AND user_id = v_user) THEN
    INSERT INTO organization_users (org_id, user_id, role_id, site_ids) VALUES (v_org_a, v_user, v_role, NULL);
  ELSE
    UPDATE organization_users SET role_id = v_role, site_ids = NULL WHERE org_id = v_org_a AND user_id = v_user;
  END IF;
END $$;

SELECT 'ORG_A_ID=' || o.id FROM organizations o
 WHERE o.name = 'Default Organization' AND o.partner_id = (SELECT partner_id FROM users WHERE email = 'admin@breeze.local') LIMIT 1;
SELECT 'SITE_A_ID=' || s.id FROM sites s JOIN organizations o ON o.id = s.org_id
 WHERE o.name = 'Default Organization' AND s.name = 'Default Site'
   AND o.partner_id = (SELECT partner_id FROM users WHERE email = 'admin@breeze.local') LIMIT 1;
SELECT 'DEVICE_A_ID=e2e60000-0000-4000-8000-000000000001';
SELECT 'ORG_B_ID=e2e60000-0000-4000-8000-000000000020';
SELECT 'SITE_B_ID=e2e60000-0000-4000-8000-000000000022';
SELECT 'DEVICE_B_ID=e2e60000-0000-4000-8000-000000000021';
