/**
 * Production-shaped fixture for connectionHealthSourceIndexes.integration.test.ts
 * (#11713). The planner picks an index from the table statistics, so a plan
 * taken over empty tables depends on whatever statistics an earlier file left
 * behind (TRUNCATE keeps pg_statistic) and on autovacuum timing. This seeds
 * every per-org table a health source reads with the shape production has,
 * thousands of healthy rows and a handful of broken ones, then ANALYZEs each
 * table the plans touch. Every table stays under ANALYZE's 30,000-row sample,
 * so ANALYZE reads every row and the statistics, and with them the plans,
 * are the same on every run.
 *
 * Seeded over the superuser connection (RLS bypassed on write; the plans are
 * still taken as breeze_app). Every row hangs off one partner, so the shared
 * cleanupDatabase() TRUNCATE ... CASCADE removes all of it.
 */
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';

export const FIXTURE = {
  orgs: 400,
  users: 200,
  oauthClients: 20,
  oauthGrants: 8000,
  dnsFilterIntegrations: 4000,
  webhookDeliveries: 20000,
  backupOrgs: 100,
  backupConfigs: 400,
  backupJobsPerConfig: 50,
  psaPartnerConnections: 20,
  psaMappings: 4000,
} as const;

/** Tables the fixture seeds or the plans join; every one is VACUUM ANALYZEd. */
const ANALYZED_TABLES = [
  'partners', 'organizations', 'users', 'sites', 'devices', 'alerts',
  'oauth_clients', 'oauth_grants',
  'dns_filter_integrations',
  'm365_connections', 'm365_sync_state',
  'webhooks', 'webhook_deliveries',
  'google_workspace_connections',
  'backup_configs', 'backup_jobs',
  'psa_connections', 'psa_ticket_mappings',
] as const;

export interface IndexFixture {
  /** Two real backup config ids: the evidence read's input. */
  backupConfigIds: [string, string];
  /** Two real webhook ids: the tracked per-id query's input. */
  webhookIds: [string, string];
}

export async function seedConnectionHealthIndexFixture(): Promise<IndexFixture> {
  const db = getTestDb();
  const run = (text: string) => db.execute(sql.raw(text));
  const f = FIXTURE;

  await run(`INSERT INTO partners (name, slug, type, plan, status, currency_code)
    VALUES ('chi partner', 'chi-partner', 'msp', 'pro', 'active', 'USD')`);
  const partner = `(SELECT id FROM partners WHERE slug = 'chi-partner')`;

  await run(`INSERT INTO organizations (partner_id, name, slug, type, status, currency_code)
    SELECT ${partner}, 'chi org ' || g, 'chi-org-' || lpad(g::text, 4, '0'), 'customer', 'active', 'USD'
    FROM generate_series(1, ${f.orgs}) g`);
  // ORGS(n): the n-th fixture org, 0-based, wrapping.
  const orgArr = `(SELECT array_agg(id ORDER BY slug) FROM organizations WHERE slug LIKE 'chi-org-%')`;

  await run(`INSERT INTO users (partner_id, email, name)
    SELECT ${partner}, 'chi-user-' || g || '@example.test', 'chi user ' || g
    FROM generate_series(1, ${f.users}) g`);
  const userArr = `(SELECT array_agg(id ORDER BY email) FROM users WHERE email LIKE 'chi-user-%')`;

  // oauth_grants: active grants, user revocations, and a few automatic
  // (refresh-token reuse) revocations, some inside the 30-day lookback.
  await run(`INSERT INTO oauth_clients (id, partner_id, metadata)
    SELECT 'chi-client-' || g, ${partner}, jsonb_build_object('client_name', 'chi client ' || g)
    FROM generate_series(1, ${f.oauthClients}) g`);
  await run(`WITH u AS (SELECT ${userArr} a)
    INSERT INTO oauth_grants (id, account_id, client_id, partner_id, payload, expires_at, created_at,
                              revoked_at, revoked_by_user_id, revoked_reason)
    SELECT 'chi-grant-' || g, u.a[(g % ${f.users}) + 1], 'chi-client-' || ((g % ${f.oauthClients}) + 1), ${partner},
      '{}'::jsonb, now() + interval '30 days', now() - (g % 90) * interval '1 day',
      CASE WHEN g % 50 = 0 THEN now() - (g % 60) * interval '1 day'
           WHEN g % 200 = 1 THEN now() - (g % 60) * interval '1 day' END,
      CASE WHEN g % 50 = 0 THEN u.a[(g % ${f.users}) + 1] END,
      CASE WHEN g % 50 = 0 THEN 'user' WHEN g % 200 = 1 THEN 'refresh-token-reuse' END
    FROM generate_series(1, ${f.oauthGrants}) g, u`);

  // dns_filter_integrations: synced minutes ago, with 1% sync errors, 0.5%
  // stale, 0.5% never synced and 5% inactive, plus an onboarding burst: 1%
  // created minutes ago and not synced yet (never synced, but not stale). The
  // burst is what never_synced_idx is for: without young never-synced rows,
  // stale_idx's `last_sync IS NULL` scan reads the same rows and the two tie.
  await run(`WITH o AS (SELECT ${orgArr} a)
    INSERT INTO dns_filter_integrations (org_id, provider, name, is_active, last_sync, last_sync_status, created_at)
    SELECT o.a[(g % ${f.orgs}) + 1], 'cloudflare', 'chi dns ' || g, g % 20 <> 0,
      CASE WHEN g % 200 = 2 OR g % 100 = 50 THEN NULL
           WHEN g % 200 = 3 THEN (now() AT TIME ZONE 'utc') - interval '7 days'
           ELSE (now() AT TIME ZONE 'utc') - interval '5 minutes' END,
      CASE WHEN g % 100 = 1 THEN 'error' WHEN g % 200 = 2 OR g % 100 = 50 THEN NULL ELSE 'success' END,
      (now() AT TIME ZONE 'utc') - CASE WHEN g % 100 = 50 THEN interval '5 minutes' ELSE interval '30 days' END
    FROM generate_series(1, ${f.dnsFilterIntegrations}) g, o`);

  // m365_connections: one legacy connection per org, 1% degraded or suspended.
  await run(`INSERT INTO m365_connections (org_id, client_id, client_secret, tenant_id, profile, auth_mode,
                                           credential_domain, permission_manifest_version, status)
    SELECT id, 'chi-app', 'sealed', gen_random_uuid()::text, 'legacy-direct', 'client-secret-legacy',
      'legacy-direct', 0,
      CASE WHEN rn % 100 = 1 THEN 'degraded' WHEN rn % 100 = 2 THEN 'suspended' ELSE 'active' END
    FROM (SELECT id, row_number() OVER (ORDER BY slug) rn FROM organizations WHERE slug LIKE 'chi-org-%') o`);

  // m365_sync_state: every domain of every connection, synced recently, with
  // a few failing, stale and never-succeeded rows, some unscheduled, and an
  // onboarding burst of rows created minutes ago with no success yet (the
  // rows never_succeeded_idx skips and stale_idx's IS NULL scan would read).
  await run(`INSERT INTO m365_sync_state (org_id, connection_id, domain, next_sync_at, interval_seconds,
                                          last_success_at, last_status, created_at)
    SELECT c.org_id, c.id, c.domain, CASE WHEN n % 25 = 0 THEN NULL ELSE now() + interval '1 hour' END, 3600,
      CASE WHEN n % 150 = 2 OR n % 75 = 5 THEN NULL
           WHEN n % 150 = 3 THEN now() - interval '7 days'
           ELSE now() - interval '30 minutes' END,
      CASE WHEN n % 150 = 1 THEN 'error'::m365_sync_status WHEN n % 150 = 4 THEN 'needs_consent'
           WHEN n % 150 = 2 OR n % 75 = 5 THEN NULL ELSE 'success' END,
      now() - CASE WHEN n % 75 = 5 THEN interval '5 minutes' ELSE interval '30 days' END
    FROM (SELECT c.id, c.org_id, d.domain, row_number() OVER (ORDER BY c.org_id, d.domain) n
          FROM m365_connections c CROSS JOIN unnest(enum_range(NULL::m365_sync_domain)) d(domain)) c`);

  // webhooks: one per org. Deliveries over 30 days: 3% failed after an
  // attempt, of which a few inside the last hour.
  await run(`INSERT INTO webhooks (org_id, name, url, status)
    SELECT id, 'chi hook', 'https://example.test/hook', 'active' FROM organizations WHERE slug LIKE 'chi-org-%'`);
  await run(`WITH w AS (SELECT array_agg(id ORDER BY id) a FROM webhooks WHERE name = 'chi hook')
    INSERT INTO webhook_deliveries (webhook_id, event_type, event_id, payload, status, attempts, created_at, failed_at, error_message)
    SELECT w.a[(g % ${f.orgs}) + 1], 'device.offline', 'chi-evt-' || g, '{}'::jsonb,
      CASE WHEN g % 33 = 0 THEN 'failed'::webhook_delivery_status ELSE 'delivered' END,
      CASE WHEN g % 33 = 0 THEN 5 ELSE 1 END,
      (now() AT TIME ZONE 'utc') - (g % 43200) * interval '1 minute',
      CASE WHEN g % 33 = 0 THEN (now() AT TIME ZONE 'utc')
        - CASE WHEN g % 990 = 0 THEN interval '10 minutes' ELSE (g % 43200) * interval '1 minute' END END,
      CASE WHEN g % 33 = 0 THEN 'HTTP 500' END
    FROM generate_series(1, ${f.webhookDeliveries}) g, w`);

  // google_workspace_connections: one per org, 1% with a failed probe.
  await run(`INSERT INTO google_workspace_connections (org_id, customer_domain, admin_email, service_account_email,
                                                       service_account_key, last_probe_at, last_probe_status)
    SELECT id, 'chi' || rn || '.example.test', 'admin@example.test', 'sa@example.test', 'sealed',
      now() AT TIME ZONE 'utc', CASE WHEN rn % 100 = 1 THEN 'failed' ELSE 'ok' END
    FROM (SELECT id, row_number() OVER (ORDER BY slug) rn FROM organizations WHERE slug LIKE 'chi-org-%') o`);

  // Backups: a device in each of the first orgs, several configs per org, and
  // a month of jobs per config (so ~10% fall inside the 72 h lookback), 3%
  // failed and 1% partial.
  await run(`INSERT INTO sites (org_id, name)
    SELECT id, 'chi site' FROM organizations WHERE slug LIKE 'chi-org-%' ORDER BY slug LIMIT ${f.backupOrgs}`);
  await run(`INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    SELECT s.org_id, s.id, 'chi-agent-' || s.id, 'chi-host', 'windows', '11', 'amd64', '2.0.0'
    FROM sites s WHERE s.name = 'chi site'`);
  await run(`WITH o AS (SELECT array_agg(org_id ORDER BY org_id) a FROM sites WHERE name = 'chi site')
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config, is_active)
    SELECT o.a[(g % ${f.backupOrgs}) + 1], 'chi backup ' || g, 'file', 's3', '{}'::jsonb, g % 20 <> 0
    FROM generate_series(1, ${f.backupConfigs}) g, o`);
  await run(`INSERT INTO backup_jobs (config_id, device_id, org_id, status, started_at, completed_at, error_log)
    SELECT c.id, d.id, c.org_id,
      CASE WHEN k % 33 = 0 THEN 'failed'::backup_status WHEN k % 100 = 1 THEN 'partial' ELSE 'completed' END,
      now() - k * interval '14 hours' - interval '10 minutes', now() - k * interval '14 hours',
      CASE WHEN k % 33 = 0 THEN 'AccessDenied: Access Denied' END
    FROM backup_configs c
    JOIN devices d ON d.org_id = c.org_id AND d.hostname = 'chi-host'
    CROSS JOIN generate_series(0, ${f.backupJobsPerConfig - 1}) k
    WHERE c.name LIKE 'chi backup %'`);

  // PSA: partner connections, an org connection per org (dual axis), and an
  // alert ledger whose mappings are created tickets, a few failed or transient.
  await run(`INSERT INTO psa_connections (partner_id, provider, name, credentials)
    SELECT ${partner}, 'connectwise', 'chi psa ' || g, '{}'::jsonb FROM generate_series(1, ${f.psaPartnerConnections}) g`);
  await run(`INSERT INTO psa_connections (org_id, provider, name, credentials)
    SELECT id, 'connectwise', 'chi org psa', '{}'::jsonb FROM organizations WHERE slug LIKE 'chi-org-%'`);
  await run(`WITH d AS (SELECT array_agg(id ORDER BY id) ids, array_agg(org_id ORDER BY id) orgs FROM devices WHERE hostname = 'chi-host')
    INSERT INTO alerts (org_id, device_id, owner_kind, severity, title)
    SELECT d.orgs[(g % ${f.backupOrgs}) + 1], d.ids[(g % ${f.backupOrgs}) + 1], 'device', 'medium', 'chi alert ' || g
    FROM generate_series(1, ${f.psaMappings}) g, d`);
  await run(`WITH c AS (SELECT array_agg(id ORDER BY name) a FROM psa_connections WHERE name LIKE 'chi psa %')
    INSERT INTO psa_ticket_mappings (connection_id, alert_id, external_ticket_id, create_state, updated_at, last_error)
    SELECT c.a[(a.n % ${f.psaPartnerConnections}) + 1], a.id,
      CASE WHEN a.n % 100 = 1 THEN NULL ELSE 'T-' || a.n END,
      CASE WHEN a.n % 100 = 1 THEN 'failed' ELSE 'created' END,
      (now() AT TIME ZONE 'utc') - (a.n % 60) * interval '1 day',
      CASE WHEN a.n % 200 = 3 THEN 'redis_unavailable' END
    FROM (SELECT id, row_number() OVER (ORDER BY title) n FROM alerts WHERE title LIKE 'chi alert %') a, c`);

  // VACUUM as well as ANALYZE: a partial index's row count (pg_class.reltuples)
  // is only set by VACUUM, so with ANALYZE alone the estimate for a partial
  // index scan moves when autovacuum gets to the table. After VACUUM ANALYZE
  // there is nothing left for autovacuum to change.
  for (const table of ANALYZED_TABLES) await run(`VACUUM ANALYZE ${table}`);

  const configs = (await db.execute(sql`
    SELECT id FROM backup_configs WHERE name IN ('chi backup 7', 'chi backup 211') ORDER BY name`)) as unknown as Array<{ id: string }>;
  const hooks = (await db.execute(sql`
    SELECT id FROM webhooks WHERE name = 'chi hook' ORDER BY id LIMIT 2`)) as unknown as Array<{ id: string }>;
  if (configs.length !== 2 || hooks.length !== 2) throw new Error('connection health index fixture: seed lookup failed');
  return { backupConfigIds: [configs[0]!.id, configs[1]!.id], webhookIds: [hooks[0]!.id, hooks[1]!.id] };
}
