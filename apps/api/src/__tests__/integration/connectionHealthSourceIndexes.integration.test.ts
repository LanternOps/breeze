/**
 * Connection health index contract (spec 2026-10-15 §1.3): every source's
 * broken-set query must be servable without a sequential scan of a table whose
 * rows grow with orgs (or users). Partner-axis tables (rows grow with
 * partners) are allowed to be scanned; any other scanned table fails, so a new
 * source has to classify its table here.
 *
 * The plans are taken once, in beforeAll, over a production-shaped fixture
 * (connectionHealthIndexFixture.ts: thousands of healthy rows, ~1% broken,
 * VACUUM ANALYZEd) and with no planner overrides (#11713). Over empty tables
 * the choice between a seq scan and each index was a tie decided by whatever
 * statistics an earlier file left behind and by autovacuum timing, which is
 * what made this file flake. The one override left is labelled where it is
 * used: it proves an index path exists, not that the planner picks it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';
import { trackedWebhooksQuery } from '../../services/connectionHealth/sources/webhook';
import { destinationConfigsQuery, destinationJobsQuery } from '../../services/connectionHealth/sources/backupDestination';
import { cleanupDatabase, getTestDb } from './setup';
import { seedConnectionHealthIndexFixture } from './connectionHealthIndexFixture';

const NOW = new Date();

/** Tables whose rows grow with orgs or users: never sequentially scanned. */
const PER_ORG_TABLES = new Set([
  'oauth_grants', 'dns_filter_integrations', 'm365_connections', 'm365_sync_state',
  // PSA connections are dual-axis; the alert ledger grows per alert/org.
  'psa_connections', 'psa_ticket_mappings',
  // W4
  'webhooks', 'webhook_deliveries', 'google_workspace_connections',
  // #11772: backup destinations are per org; their jobs grow with every run.
  'backup_configs', 'backup_jobs',
]);
/** Tables whose rows grow with partners (one or a few per partner): a scan is acceptable. */
const PARTNER_AXIS_TABLES = new Set([
  'huntress_integrations',
  's1_integrations',
  'pax8_integrations',
  'unifi_integrations',
  'backup_provider_connections',
  'edr_connections',
  'accounting_connections',
  'ticket_mailbox_connections',
]);

/**
 * Per-org tables the planner does seq-scan on the natural plan of a source's
 * broken query. For these the contract checked is only that an index path
 * exists (the plan with enable_seqscan = off has no Seq Scan on them), NOT
 * that the planner picks it. Each entry needs an open issue.
 *
 * backup_destination / backup_configs (#11792): the RLS policy filter inflates
 * the job-side estimate, so the planner hash-joins and seq-scans
 * backup_configs.
 */
const KNOWN_NATURAL_SEQ_SCANS: Record<string, readonly string[]> = {
  backup_destination: ['backup_configs'],
};

/**
 * Every index this file names, with its definition as the migrations create
 * it. A dropped or redefined index fails here by name, whatever the planner
 * would have done without it.
 */
const PURPOSE_BUILT_INDEXES: Record<string, string> = {
  dns_filter_integrations_sync_error_idx:
    "CREATE INDEX dns_filter_integrations_sync_error_idx ON public.dns_filter_integrations USING btree (id) WHERE (is_active AND ((last_sync_status)::text = 'error'::text))",
  dns_filter_integrations_stale_idx:
    "CREATE INDEX dns_filter_integrations_stale_idx ON public.dns_filter_integrations USING btree (last_sync) WHERE is_active",
  dns_filter_integrations_never_synced_idx:
    "CREATE INDEX dns_filter_integrations_never_synced_idx ON public.dns_filter_integrations USING btree (created_at) WHERE (is_active AND (last_sync IS NULL))",
  m365_connections_unhealthy_idx:
    "CREATE INDEX m365_connections_unhealthy_idx ON public.m365_connections USING btree (id) WHERE ((org_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['degraded'::character varying, 'suspended'::character varying])::text[])))",
  m365_sync_state_unhealthy_idx:
    "CREATE INDEX m365_sync_state_unhealthy_idx ON public.m365_sync_state USING btree (connection_id) WHERE (last_status = ANY (ARRAY['needs_consent'::m365_sync_status, 'error'::m365_sync_status]))",
  m365_sync_state_stale_idx:
    "CREATE INDEX m365_sync_state_stale_idx ON public.m365_sync_state USING btree (last_success_at) WHERE (next_sync_at IS NOT NULL)",
  m365_sync_state_never_succeeded_idx:
    "CREATE INDEX m365_sync_state_never_succeeded_idx ON public.m365_sync_state USING btree (created_at) WHERE ((next_sync_at IS NOT NULL) AND (last_success_at IS NULL))",
  oauth_grants_auto_revoked_idx:
    "CREATE INDEX oauth_grants_auto_revoked_idx ON public.oauth_grants USING btree (revoked_at) WHERE ((revoked_reason = 'refresh-token-reuse'::text) AND (revoked_by_user_id IS NULL))",
  webhook_deliveries_failed_at_recent_idx:
    "CREATE INDEX webhook_deliveries_failed_at_recent_idx ON public.webhook_deliveries USING btree (failed_at) WHERE (status = 'failed'::webhook_delivery_status)",
  webhook_deliveries_failed_webhook_idx:
    "CREATE INDEX webhook_deliveries_failed_webhook_idx ON public.webhook_deliveries USING btree (webhook_id, created_at) WHERE ((status = 'failed'::webhook_delivery_status) AND (attempts > 0))",
  google_workspace_connections_probe_failed_idx:
    "CREATE INDEX google_workspace_connections_probe_failed_idx ON public.google_workspace_connections USING btree (id) WHERE ((last_probe_status)::text = 'failed'::text)",
  backup_jobs_unsuccessful_completed_at_idx:
    "CREATE INDEX backup_jobs_unsuccessful_completed_at_idx ON public.backup_jobs USING btree (completed_at, config_id) WHERE (status = ANY (ARRAY['failed'::backup_status, 'partial'::backup_status, 'completed_with_errors'::backup_status]))",
  backup_jobs_config_completed_at_idx:
    "CREATE INDEX backup_jobs_config_completed_at_idx ON public.backup_jobs USING btree (config_id, completed_at)",
};

async function explain(query: SQL | SQLWrapper, opts: { forceIndexPath?: boolean } = {}): Promise<string> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    if (opts.forceIndexPath) await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const rows = (await tx.execute(sql`EXPLAIN ${query}`)) as unknown as Array<Record<string, string>>;
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  })));
}

const sourceOf = (kind: string) => {
  const source = HEALTH_SOURCES.find((s) => s.kind === kind);
  if (!source) throw new Error(`no health source ${kind}`);
  return source;
};

/** A scan node on `index` whose next line is an Index Cond matching `cond` (any Index Cond if omitted). */
const indexCondOn = (index: string, cond = '') =>
  new RegExp(`(?:Bitmap Index|Index|Index Only) Scan on ${index}[^\\n]*\\n\\s*Index Cond: [^\\n]*${cond}`);

const plans = {
  natural: new Map<string, string>(),
  forced: new Map<string, string>(),
  trackedWebhooks: [] as string[],
  evidence: [] as string[],
  configLookup: [] as string[],
};

beforeAll(async () => {
  // The m365_sync stale arm is compiled only with tenant sync on (#10021 D7a).
  vi.stubEnv('M365_TENANT_SYNC_ENABLED', 'true');
  // The global beforeEach has not run yet: clear what the previous file left.
  await cleanupDatabase();
  const fixture = await seedConnectionHealthIndexFixture();
  for (const source of HEALTH_SOURCES) {
    plans.natural.set(source.kind, await explain(source.brokenQuery(NOW)));
    if (KNOWN_NATURAL_SEQ_SCANS[source.kind]) {
      plans.forced.set(source.kind, await explain(source.brokenQuery(NOW), { forceIndexPath: true }));
    }
  }
  for (const ids of [fixture.webhookIds, [randomUUID(), randomUUID()]]) {
    plans.trackedWebhooks.push(await explain(trackedWebhooksQuery(ids)));
  }
  for (const ids of [fixture.backupConfigIds, [randomUUID(), randomUUID()]]) {
    plans.evidence.push(await explain(destinationJobsQuery(ids, NOW)));
    plans.configLookup.push(await explain(destinationConfigsQuery(ids).getSQL()));
  }
}, 120_000);
afterAll(() => { vi.unstubAllEnvs(); });

describe('connection health source index contract (spec §1.3)', () => {
  it('classifies every table a source covers', () => {
    for (const s of HEALTH_SOURCES) {
      for (const t of s.tables) {
        expect(PER_ORG_TABLES.has(t) || PARTNER_AXIS_TABLES.has(t), `${s.kind}: classify ${t}`).toBe(true);
      }
    }
  });

  it.each(Object.entries(PURPOSE_BUILT_INDEXES))('%s exists, is valid and keeps its definition', async (index, definition) => {
    const rows = (await getTestDb().execute(sql`
      SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${index}`)) as unknown as Array<{ def: string; valid: boolean }>;
    expect(rows, `index ${index} is missing`).toHaveLength(1);
    expect(rows[0]!.valid, `index ${index} is invalid`).toBe(true);
    expect(rows[0]!.def).toBe(definition);
  });

  it.each(HEALTH_SOURCES.map((s) => [s.kind] as const))('%s broken query scans no per-org table sequentially', (kind) => {
    const plan = plans.natural.get(kind)!;
    const known = KNOWN_NATURAL_SEQ_SCANS[kind] ?? [];
    const scanned = [...plan.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1]!);
    for (const table of scanned) {
      if (known.includes(table)) continue;
      expect(PER_ORG_TABLES.has(table), `Seq Scan on per-org table ${table}:\n${plan}`).toBe(false);
      expect(PARTNER_AXIS_TABLES.has(table), `Seq Scan on unclassified table ${table}:\n${plan}`).toBe(true);
    }
  });

  // Known gap, tracked in #11792: the planner seq-scans backup_configs for
  // this query. What is guaranteed today is only that an index path exists.
  it('backup_destination: an index path exists for backup_configs (not that the planner picks it; #11792)', () => {
    const plan = plans.forced.get('backup_destination')!;
    for (const table of KNOWN_NATURAL_SEQ_SCANS.backup_destination!) {
      expect(plan, plan).not.toContain(`Seq Scan on ${table}`);
    }
  });

  it.each([
    ['dns_filter', 'dns_filter_integrations_sync_error_idx'],
    ['m365_connection', 'm365_connections_unhealthy_idx'],
    ['m365_sync', 'm365_sync_state_unhealthy_idx'],
    ['oauth_grant', 'oauth_grants_auto_revoked_idx'],
    ['webhook', 'webhook_deliveries_failed_at_recent_idx'],
    ['google_workspace', 'google_workspace_connections_probe_failed_idx'],
    ['backup_destination', 'backup_jobs_unsuccessful_completed_at_idx'],
  ])('%s uses %s', (kind, index) => {
    const plan = plans.natural.get(sourceOf(kind).kind)!;
    expect(plan, plan).toContain(index);
  });

  // Plan D5c, corrected: under RLS (the app role) the planner pushes only
  // leakproof quals into an index, so an index on the stale-at expression is
  // never an Index Cond (it degraded to an is_active filter reading every
  // active row). The stale arms are plain-column pre-filters; this asserts each
  // is an Index Cond, tying schema, source and migration.
  it.each([
    ['dns_filter', 'dns_filter_integrations_stale_idx', 'last_sync <'],
    ['m365_sync', 'm365_sync_state_stale_idx', 'last_success_at <'],
  ])('%s: the stale arm is an Index Cond on %s', (kind, index, cond) => {
    const plan = plans.natural.get(kind)!;
    expect(plan, plan).toMatch(indexCondOn(index, cond));
  });

  // The never-synced arm can be served two ways: by its purpose-built index
  // (Index Cond on created_at), or by the stale index, which also holds the
  // NULLs (Index Cond `IS NULL`). Over production-shaped statistics the
  // planner prefers the stale index (#11792 asks whether the purpose-built
  // one should go). Either way the arm is index-served and its cost is bounded
  // by the never-synced rows; the existence check above keeps both indexes.
  it.each([
    ['dns_filter', 'dns_filter_integrations_never_synced_idx', 'dns_filter_integrations_stale_idx', 'last_sync IS NULL', 'dns_filter_integrations'],
    ['m365_sync', 'm365_sync_state_never_succeeded_idx', 'm365_sync_state_stale_idx', 'last_success_at IS NULL', 'm365_sync_state'],
  ])('%s: the never-synced arm is an Index Cond on %s, or on %s with `%s`', (kind, purposeBuilt, stale, isNull, table) => {
    const plan = plans.natural.get(kind)!;
    const served = indexCondOn(purposeBuilt).test(plan) || indexCondOn(stale, isNull).test(plan);
    expect(served, plan).toBe(true);
    expect(plan, plan).not.toContain(`Seq Scan on ${table}`);
  });

  it('webhook: the windowed broken query never walks the per-webhook failed index (W4)', () => {
    expect(plans.natural.get('webhook')).not.toContain('webhook_deliveries_failed_webhook_idx');
  });

  it.each([0, 1].map((i) => [i === 0 ? 'real' : 'unknown', i] as const))(
    'webhook: the tracked per-id query (%s ids) uses the per-webhook failed index, no seq scan on deliveries (W4)',
    (_label, i) => {
      const plan = plans.trackedWebhooks[i]!;
      expect(plan, plan).toContain('webhook_deliveries_failed_webhook_idx');
      expect(plan, plan).not.toContain('Seq Scan on webhook_deliveries');
    },
  );

  it.each([0, 1].map((i) => [i === 0 ? 'real' : 'unknown', i] as const))(
    'backup_destination: the evidence read (%s config ids) uses the per-config completed index, no seq scan on jobs (#11772)',
    (_label, i) => {
      const plan = plans.evidence[i]!;
      expect(plan, plan).toContain('backup_jobs_config_completed_at_idx');
      expect(plan, plan).not.toContain('Seq Scan on backup_jobs');
    },
  );

  it.each([0, 1].map((i) => [i === 0 ? 'real' : 'unknown', i] as const))(
    'backup_destination: the config lookup (%s ids) reads configs by primary key (#11772)',
    (_label, i) => {
      const plan = plans.configLookup[i]!;
      expect(plan, plan).toContain('backup_configs_pkey');
      expect(plan, plan).not.toContain('Seq Scan on backup_configs');
    },
  );
});
