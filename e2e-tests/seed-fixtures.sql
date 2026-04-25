-- E2E test fixtures for fresh-DB runs.
-- Run via:
--   docker exec -i breeze-postgres psql -U breeze -d breeze < e2e-tests/seed-fixtures.sql
--
-- Idempotent: safe to re-run. Inserts the minimum data the YAML test
-- suite under e2e-tests/tests/ assumes already exists — two devices
-- whose IDs match E2E_MACOS_DEVICE_ID / E2E_WINDOWS_DEVICE_ID, plus a
-- couple of alerts and audit events so list pages aren't empty.
--
-- Tracks issue #518.

DO $$
DECLARE
  v_org_id UUID;
  v_site_id UUID;
  v_user_id UUID;
  v_macos_device_id UUID := '42fc7de0-48f5-48f2-846b-6dd95924baf9';
  v_windows_device_id UUID := 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'No organization found — run autoMigrate seed first.';
    RETURN;
  END IF;

  SELECT id INTO v_site_id FROM sites WHERE org_id = v_org_id LIMIT 1;
  IF v_site_id IS NULL THEN
    RAISE NOTICE 'No site found — run autoMigrate seed first.';
    RETURN;
  END IF;

  SELECT id INTO v_user_id FROM users WHERE email = 'admin@breeze.local' LIMIT 1;

  -- Devices (idempotent on id)
  INSERT INTO devices (id, org_id, site_id, agent_id, hostname, display_name, os_type, os_version, architecture, agent_version, status, last_seen_at)
  VALUES
    (v_macos_device_id, v_org_id, v_site_id, 'e2e-macos-agent', 'e2e-macos.local', 'E2E macOS Test Device', 'macos', '14.5', 'arm64', '0.63.0', 'online', NOW()),
    (v_windows_device_id, v_org_id, v_site_id, 'e2e-windows-agent', 'e2e-windows.local', 'E2E Windows Test Device', 'windows', '11.0.22631', 'amd64', '0.63.0', 'online', NOW())
  ON CONFLICT (id) DO UPDATE
    SET status = 'online', last_seen_at = NOW(), updated_at = NOW();

  -- Alerts (one per device, dedupe by title since the table has no source column)
  INSERT INTO alerts (org_id, device_id, severity, status, title, message, triggered_at)
  SELECT v_org_id, v_macos_device_id, 'medium', 'active', 'E2E fixture: high CPU', 'Synthetic alert for e2e suite.', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE device_id = v_macos_device_id AND title = 'E2E fixture: high CPU');

  INSERT INTO alerts (org_id, device_id, severity, status, title, message, triggered_at)
  SELECT v_org_id, v_windows_device_id, 'critical', 'active', 'E2E fixture: disk full', 'Synthetic alert for e2e suite.', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE device_id = v_windows_device_id AND title = 'E2E fixture: disk full');

  -- Audit events (a few so the list/sort/filter tests have something to render)
  INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, resource_id, result, ip_address)
  SELECT v_org_id, 'user', v_user_id, 'e2e.fixture.seeded', 'system', v_org_id, 'success', '127.0.0.1'
  WHERE v_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'e2e.fixture.seeded' AND org_id = v_org_id);

  RAISE NOTICE 'E2E fixtures seeded for org %', v_org_id;
END $$;
