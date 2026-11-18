-- Isolated, idempotent W02 fixture. No sync or notification jobs are queued.
-- Applied by org-subject-alerts.spec.ts on the orchestrator's worktree stack.
DO $$
DECLARE
  v_org uuid;
  v_partner uuid;
  v_connection uuid := 'e2e10727-0000-4000-8000-000000000001';
  v_customer uuid := 'e2e10727-0000-4000-8000-000000000002';
  v_workload uuid := 'e2e10727-0000-4000-8000-000000000003';
  v_alert uuid := 'e2e10727-0000-4000-8000-000000000004';
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  -- Playwright runs one beforeAll per worker; serialize concurrent seeds so the
  -- composite unique indexes are not raced (one worker inserts, the next upserts).
  PERFORM pg_advisory_xact_lock(hashtext('e2e-org-subject-alerts-seed'));
  SELECT o.id, o.partner_id INTO v_org, v_partner
    FROM organizations o JOIN users u ON u.partner_id = o.partner_id
   WHERE u.email = 'admin@breeze.local' AND o.name = 'Default Organization' LIMIT 1;
  IF v_org IS NULL THEN RAISE EXCEPTION 'seed: Default Organization missing'; END IF;

  INSERT INTO backup_provider_connections (id, partner_id, provider, name, credentials_encrypted, is_active)
  VALUES (v_connection, v_partner, 'cove', 'E2E org-subject backup', 'e2e-inactive-placeholder', false)
  ON CONFLICT (id) DO UPDATE SET is_active = false;
  INSERT INTO backup_provider_customers (id, connection_id, partner_id, vendor_customer_id, vendor_customer_name, org_id)
  VALUES (v_customer, v_connection, v_partner, 'e2e-org-subject-customer', 'Example customer', v_org)
  ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id;
  INSERT INTO backup_provider_devices (id, connection_id, partner_id, org_id, customer_id, provider,
                                       vendor_device_id, vendor_device_name, account_type, data_sources,
                                       portal_show_provider_name, status)
  VALUES (v_workload, v_connection, v_partner, v_org, v_customer, 'cove', 'e2e-org-subject-workload',
          'Synthetic mail workload', 'm365', ARRAY['m365_mail'], false, 'failed')
  ON CONFLICT (id) DO UPDATE SET status = 'failed';
  INSERT INTO alerts (id, org_id, device_id, owner_kind, owner_ref, status, severity, title, message, context, triggered_at)
  VALUES (v_alert, v_org, NULL, 'backup_workload', v_workload::text, 'active', 'high',
          'E2E org-subject backup failed', 'Microsoft 365 mail backup failed',
          '{"source":"backup_provider","providerDeviceId":"e2e10727-0000-4000-8000-000000000003"}'::jsonb, now())
  ON CONFLICT (id) DO UPDATE SET status = 'active', triggered_at = now(), resolved_at = NULL, dismissed_at = NULL;
END $$;
