-- E2E fixture: a second, unrelated tenant ("tenant B") for
-- tests/tenant-isolation.spec.ts.
--
-- Creates partner B with one organization, site and device, an alert on that
-- device, and a Partner Admin user (tenant-b@breeze.local) who signs in with
-- the same password as admin@breeze.local (the hash is copied, so no hashing
-- happens here). Nothing in partner B is linked to the default partner.
--
-- Every row that B's data could leak through carries the marker string
-- E2E-TENANT-B-SECRET, so the spec can assert that tenant A never sees it.
--
-- Idempotent: fixed slug, email and ids; re-running refreshes the rows.
-- Ids are emitted on stdout. Run with -v ON_ERROR_STOP=1.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  v_partner   uuid := 'b0000000-0000-4000-8000-0000000000b1';
  v_org       uuid := 'b0000000-0000-4000-8000-0000000000b2';
  v_site      uuid := 'b0000000-0000-4000-8000-0000000000b3';
  v_device    uuid := 'b0000000-0000-4000-8000-0000000000b4';
  v_user      uuid := 'b0000000-0000-4000-8000-0000000000b5';
  v_alert     uuid := 'b0000000-0000-4000-8000-0000000000b6';
  v_role      uuid;
  v_hash      text;
BEGIN
  SELECT password_hash INTO v_hash FROM users WHERE email = 'admin@breeze.local';
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local not found or has no password — is the stack seeded?';
  END IF;

  SELECT id INTO v_role FROM roles
   WHERE name = 'Partner Admin' AND is_system AND partner_id IS NULL AND org_id IS NULL
   LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'seed: system Partner Admin role not found';
  END IF;

  INSERT INTO partners (id, name, slug, type, plan)
  VALUES (v_partner, 'E2E-TENANT-B-SECRET Partner', 'e2e-tenant-b', 'msp', 'enterprise')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
  VALUES (v_org, v_partner, 'E2E-TENANT-B-SECRET Org', 'e2e-tenant-b-org', 'active', 'USD')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active';

  INSERT INTO sites (id, org_id, name, timezone)
  VALUES (v_site, v_org, 'E2E-TENANT-B-SECRET Site', 'UTC')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO devices (id, org_id, site_id, agent_id, hostname, display_name, os_type, os_version,
                       architecture, agent_version, status, last_seen_at)
  VALUES (v_device, v_org, v_site, 'e2e-tenant-b-agent', 'e2e-tenant-b-secret.local',
          'E2E-TENANT-B-SECRET Device', 'windows', '11.0.22631', 'amd64', '0.63.0', 'online', NOW())
  ON CONFLICT (id) DO UPDATE SET status = 'online', last_seen_at = NOW(), updated_at = NOW();

  INSERT INTO alerts (id, org_id, device_id, severity, status, title, message, triggered_at)
  VALUES (v_alert, v_org, v_device, 'high', 'active', 'E2E-TENANT-B-SECRET alert',
          'E2E-TENANT-B-SECRET alert body', NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO users (id, partner_id, email, name, password_hash, status, email_verified_at)
  VALUES (v_user, v_partner, 'tenant-b@breeze.local', 'E2E Tenant B Admin', v_hash, 'active', NOW())
  ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active';

  IF NOT EXISTS (SELECT 1 FROM partner_users WHERE partner_id = v_partner AND user_id = v_user) THEN
    INSERT INTO partner_users (partner_id, user_id, role_id, org_access)
    VALUES (v_partner, v_user, v_role, 'all');
  END IF;
END $$;

SELECT 'PARTNER_ID=b0000000-0000-4000-8000-0000000000b1';
SELECT 'ORG_ID=b0000000-0000-4000-8000-0000000000b2';
SELECT 'SITE_ID=b0000000-0000-4000-8000-0000000000b3';
SELECT 'DEVICE_ID=b0000000-0000-4000-8000-0000000000b4';
SELECT 'ALERT_ID=b0000000-0000-4000-8000-0000000000b6';
