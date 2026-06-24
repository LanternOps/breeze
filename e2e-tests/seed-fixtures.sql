-- E2E test fixtures for fresh-DB runs (raw-SQL fallback).
--
-- PREFER the app-layer seed: `pnpm --filter @breeze/api db:seed:e2e`
-- (apps/api/src/db/seedE2eFixtures.ts). It runs through Drizzle inside
-- withSystemDbAccessContext, so it works anywhere the API can reach the DB —
-- not just where a `breeze-postgres` container happens to be named — and is
-- kept in sync with the schema by the type-checker. This SQL file is retained
-- only as a zero-dependency fallback for psql-only environments.
--
-- Run via:
--   docker exec -i breeze-postgres psql -U breeze -d breeze < e2e-tests/seed-fixtures.sql
--
-- Idempotent: safe to re-run. Inserts the minimum data the YAML test
-- suite under e2e-tests/tests/ assumes already exists. Pure SQL via
-- the breeze superuser — bypasses the API, so RLS / business
-- validation are NOT exercised. That's fine for fixture setup.
--
-- Tracks issue #518.

DO $$
DECLARE
  v_org_id UUID;
  v_site_id UUID;
  v_user_id UUID;
  v_macos_device_id  UUID := '42fc7de0-48f5-48f2-846b-6dd95924baf9';
  v_windows_device_id UUID := 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';
  v_baseline_win UUID;
  v_baseline_mac UUID;
  v_backup_config UUID;
  v_patch_critical UUID;
  v_patch_important UUID;
  v_patch_moderate UUID;
  v_vuln_critical UUID;
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

  -- ───────────────────────────────────────────────────────────────────
  -- Mark admin setup complete so the setup wizard is skipped on login.
  -- userRequiresSetup() returns true for admin@breeze.local when
  -- setup_completed_at IS NULL, redirecting to /setup and breaking E2E.
  -- ───────────────────────────────────────────────────────────────────
  IF v_user_id IS NOT NULL THEN
    UPDATE users
    SET setup_completed_at = NOW(),
        preferences = preferences - 'bootstrapSetupRequired'
    WHERE id = v_user_id AND setup_completed_at IS NULL;
  END IF;

  -- ───────────────────────────────────────────────────────────────────
  -- Devices
  -- ───────────────────────────────────────────────────────────────────
  INSERT INTO devices (id, org_id, site_id, agent_id, hostname, display_name, os_type, os_version, architecture, agent_version, status, last_seen_at)
  VALUES
    (v_macos_device_id,   v_org_id, v_site_id, 'e2e-macos-agent',   'e2e-macos.local',   'E2E macOS Test Device',   'macos',   '14.5',         'arm64', '0.63.0', 'online', NOW()),
    (v_windows_device_id, v_org_id, v_site_id, 'e2e-windows-agent', 'e2e-windows.local', 'E2E Windows Test Device', 'windows', '11.0.22631',   'amd64', '0.63.0', 'online', NOW())
  ON CONFLICT (id) DO UPDATE
    SET status = 'online', last_seen_at = NOW(), updated_at = NOW();

  -- ───────────────────────────────────────────────────────────────────
  -- Device groups
  -- ───────────────────────────────────────────────────────────────────
  INSERT INTO device_groups (org_id, site_id, name, type)
  SELECT v_org_id, v_site_id, 'E2E All Test Devices', 'static'
  WHERE NOT EXISTS (SELECT 1 FROM device_groups WHERE org_id = v_org_id AND name = 'E2E All Test Devices');

  -- ───────────────────────────────────────────────────────────────────
  -- Alerts
  -- ───────────────────────────────────────────────────────────────────
  INSERT INTO alerts (org_id, device_id, severity, status, title, message, triggered_at)
  SELECT v_org_id, v_macos_device_id, 'medium', 'active', 'E2E fixture: high CPU', 'Synthetic alert for e2e suite.', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE device_id = v_macos_device_id AND title = 'E2E fixture: high CPU');

  INSERT INTO alerts (org_id, device_id, severity, status, title, message, triggered_at)
  SELECT v_org_id, v_windows_device_id, 'critical', 'active', 'E2E fixture: disk full', 'Synthetic alert for e2e suite.', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE device_id = v_windows_device_id AND title = 'E2E fixture: disk full');

  -- ───────────────────────────────────────────────────────────────────
  -- Audit log seed
  -- ───────────────────────────────────────────────────────────────────
  INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, resource_id, result, ip_address)
  SELECT v_org_id, 'user', v_user_id, 'e2e.fixture.seeded', 'system', v_org_id, 'success', '127.0.0.1'
  WHERE v_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'e2e.fixture.seeded' AND org_id = v_org_id);

  -- ───────────────────────────────────────────────────────────────────
  -- Device software (inventory rows so list/filter pages aren't empty)
  -- ───────────────────────────────────────────────────────────────────
  INSERT INTO device_software (device_id, name, version, publisher, is_system)
  SELECT v_macos_device_id, n, v, p, false FROM (VALUES
    ('Google Chrome',  '120.0.6099', 'Google LLC'),
    ('Slack',          '4.36.140',   'Slack Technologies'),
    ('Visual Studio Code', '1.85.0', 'Microsoft Corporation')
  ) AS s(n, v, p)
  WHERE NOT EXISTS (SELECT 1 FROM device_software WHERE device_id = v_macos_device_id AND name = s.n);

  INSERT INTO device_software (device_id, name, version, publisher, is_system)
  SELECT v_windows_device_id, n, v, p, false FROM (VALUES
    ('Microsoft Edge',     '120.0.2210', 'Microsoft Corporation'),
    ('7-Zip 19.00 (x64)',  '19.00',      'Igor Pavlov'),
    ('Notepad++ (64-bit)', '8.6.0',      'Notepad++ Team')
  ) AS s(n, v, p)
  WHERE NOT EXISTS (SELECT 1 FROM device_software WHERE device_id = v_windows_device_id AND name = s.n);

  -- ───────────────────────────────────────────────────────────────────
  -- Browser extensions (Windows device only)
  -- ───────────────────────────────────────────────────────────────────
  INSERT INTO browser_extensions (org_id, device_id, browser, extension_id, name, version, source, permissions, risk_level, enabled, first_seen_at, last_seen_at)
  VALUES
    (v_org_id, v_windows_device_id, 'edge', 'cjpalhdlnbpafiamejdnhcphjbkeiagm', 'uBlock Origin', '1.54.0', 'webstore', '["webRequest","storage"]'::jsonb, 'low',    true, NOW(), NOW()),
    (v_org_id, v_windows_device_id, 'edge', 'gighmmpiobklfepjocnamgkkbiglidom', 'AdBlock',       '5.16.1', 'webstore', '["webRequest","tabs"]'::jsonb,    'medium', true, NOW(), NOW())
  ON CONFLICT (org_id, device_id, browser, extension_id) DO NOTHING;

  -- ───────────────────────────────────────────────────────────────────
  -- CIS baselines + per-device results
  -- ───────────────────────────────────────────────────────────────────
  SELECT id INTO v_baseline_win FROM cis_baselines WHERE org_id = v_org_id AND name = 'E2E Windows L1' LIMIT 1;
  IF v_baseline_win IS NULL THEN
    INSERT INTO cis_baselines (org_id, name, os_type, benchmark_version, level)
    VALUES (v_org_id, 'E2E Windows L1', 'windows', '2.0.0', 'l1')
    RETURNING id INTO v_baseline_win;
  END IF;

  SELECT id INTO v_baseline_mac FROM cis_baselines WHERE org_id = v_org_id AND name = 'E2E macOS L1' LIMIT 1;
  IF v_baseline_mac IS NULL THEN
    INSERT INTO cis_baselines (org_id, name, os_type, benchmark_version, level)
    VALUES (v_org_id, 'E2E macOS L1', 'macos', '4.0.0', 'l1')
    RETURNING id INTO v_baseline_mac;
  END IF;

  INSERT INTO cis_baseline_results (org_id, device_id, baseline_id, checked_at, total_checks, passed_checks, failed_checks, score)
  SELECT v_org_id, v_windows_device_id, v_baseline_win, NOW(), 100, 87, 13, 87
  WHERE NOT EXISTS (SELECT 1 FROM cis_baseline_results WHERE device_id = v_windows_device_id AND baseline_id = v_baseline_win);

  INSERT INTO cis_baseline_results (org_id, device_id, baseline_id, checked_at, total_checks, passed_checks, failed_checks, score)
  SELECT v_org_id, v_macos_device_id, v_baseline_mac, NOW(), 80, 72, 8, 90
  WHERE NOT EXISTS (SELECT 1 FROM cis_baseline_results WHERE device_id = v_macos_device_id AND baseline_id = v_baseline_mac);

  -- ───────────────────────────────────────────────────────────────────
  -- Backup config + backup jobs (one per device, one success + one failed)
  -- ───────────────────────────────────────────────────────────────────
  SELECT id INTO v_backup_config FROM backup_configs WHERE org_id = v_org_id AND name = 'E2E Default Backup' LIMIT 1;
  IF v_backup_config IS NULL THEN
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (v_org_id, 'E2E Default Backup', 'file', 'local', '{"path":"/var/breeze/backups"}'::jsonb)
    RETURNING id INTO v_backup_config;
  END IF;

  INSERT INTO backup_jobs (org_id, config_id, device_id, status, type, started_at, completed_at, total_size, transferred_size, file_count)
  SELECT v_org_id, v_backup_config, v_macos_device_id, 'completed', 'scheduled', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 45 minutes', 1234567890, 1234567890, 4823
  WHERE NOT EXISTS (SELECT 1 FROM backup_jobs WHERE device_id = v_macos_device_id AND status = 'completed');

  INSERT INTO backup_jobs (org_id, config_id, device_id, status, type, started_at, completed_at, error_log)
  SELECT v_org_id, v_backup_config, v_windows_device_id, 'failed', 'scheduled', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours 50 minutes', 'E2E synthetic failure: target unreachable'
  WHERE NOT EXISTS (SELECT 1 FROM backup_jobs WHERE device_id = v_windows_device_id AND status = 'failed');

  -- ───────────────────────────────────────────────────────────────────
  -- Patches + device_patches links (Windows device gets the queue)
  -- ───────────────────────────────────────────────────────────────────
  SELECT id INTO v_patch_critical FROM patches WHERE source = 'microsoft' AND external_id = 'E2E-KB5000001' LIMIT 1;
  IF v_patch_critical IS NULL THEN
    INSERT INTO patches (source, external_id, title, severity, os_types, kb_article_url, requires_reboot)
    VALUES ('microsoft', 'E2E-KB5000001', 'Cumulative Update for Windows 11 (E2E synthetic)', 'critical', ARRAY['windows'], 'https://support.microsoft.com/en-us/help/E2E-KB5000001', true)
    RETURNING id INTO v_patch_critical;
  END IF;

  SELECT id INTO v_patch_important FROM patches WHERE source = 'microsoft' AND external_id = 'E2E-KB5000002' LIMIT 1;
  IF v_patch_important IS NULL THEN
    INSERT INTO patches (source, external_id, title, severity, os_types, requires_reboot)
    VALUES ('microsoft', 'E2E-KB5000002', 'Microsoft Defender Definition Update (E2E)', 'important', ARRAY['windows'], false)
    RETURNING id INTO v_patch_important;
  END IF;

  SELECT id INTO v_patch_moderate FROM patches WHERE source = 'apple' AND external_id = 'E2E-MAC-001' LIMIT 1;
  IF v_patch_moderate IS NULL THEN
    INSERT INTO patches (source, external_id, title, severity, os_types, requires_reboot)
    VALUES ('apple', 'E2E-MAC-001', 'Safari 17.2 Security Update (E2E)', 'moderate', ARRAY['macos'], false)
    RETURNING id INTO v_patch_moderate;
  END IF;

  INSERT INTO device_patches (org_id, device_id, patch_id, status, last_checked_at)
  SELECT v_org_id, v_windows_device_id, v_patch_critical, 'pending', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM device_patches WHERE device_id = v_windows_device_id AND patch_id = v_patch_critical);

  INSERT INTO device_patches (org_id, device_id, patch_id, status, installed_at, last_checked_at)
  SELECT v_org_id, v_windows_device_id, v_patch_important, 'installed', NOW() - INTERVAL '1 day', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM device_patches WHERE device_id = v_windows_device_id AND patch_id = v_patch_important);

  INSERT INTO device_patches (org_id, device_id, patch_id, status, last_checked_at)
  SELECT v_org_id, v_macos_device_id, v_patch_moderate, 'pending', NOW()
  WHERE NOT EXISTS (SELECT 1 FROM device_patches WHERE device_id = v_macos_device_id AND patch_id = v_patch_moderate);

  -- Vulnerability management (BE-16): one open, KEV-flagged CVE on the Windows
  -- device so the fleet dashboard + per-device tab render a row and the
  -- accept-risk flow has something to act on. Idempotent like the rest.
  SELECT id INTO v_vuln_critical FROM vulnerabilities WHERE cve_id = 'CVE-2025-E2E-0001' LIMIT 1;
  IF v_vuln_critical IS NULL THEN
    INSERT INTO vulnerabilities (cve_id, source, description, severity, cvss_version, cvss_score, known_exploited, patch_available, raw_payload)
    VALUES ('CVE-2025-E2E-0001', 'nvd', 'E2E synthetic critical vulnerability', 'critical', '3.1', 9.8, true, true, '{"e2e": true}'::jsonb)
    RETURNING id INTO v_vuln_critical;
  END IF;

  INSERT INTO device_vulnerabilities (org_id, device_id, vulnerability_id, status, risk_score, detected_at)
  SELECT v_org_id, v_windows_device_id, v_vuln_critical, 'open', 100.00, NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM device_vulnerabilities WHERE device_id = v_windows_device_id AND vulnerability_id = v_vuln_critical
  );

  -- Reset to OPEN on every seed run so the accept-risk e2e (which mutates this
  -- row to 'accepted') is re-runnable without a fresh DB.
  UPDATE device_vulnerabilities
    SET status = 'open', accepted_by = NULL, accepted_until = NULL, resolved_at = NULL, mitigation_note = NULL
    WHERE device_id = v_windows_device_id AND vulnerability_id = v_vuln_critical;

  RAISE NOTICE 'E2E fixtures seeded for org %', v_org_id;
END $$;
