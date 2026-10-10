/**
 * #8053 — DB cost budget for the two hottest agent request paths, measured
 * against REAL PostgreSQL.
 *
 * Every agent heartbeats every 60 s and polls `/unifi-collectors` every 30 s,
 * so per-request transaction and statement counts multiply by the whole fleet:
 * at v0.121 the API's single event loop saturated at ~200-250 online agents.
 * These budgets pin the counts after #8053 so a new per-beat transaction or a
 * re-introduced per-request reload shows up as a red test instead of as the
 * next production saturation. W0d (#8151) extends the same gate to every
 * request and WS frame the agent simulator (agent/tools/agentsim) sends.
 *
 * How it counts: `postgres` is wrapped so the request pool (the one client
 * named `application_name: 'breeze-api'`, i.e. the production `db`) gets a
 * postgres.js `debug` hook. The hook sees every statement that pool sends —
 * `begin` (a top-level transaction), `savepoint`, the RLS `set_config`
 * prologue and every data statement. Fixture setup uses the separate
 * superuser test client and is never counted. The hook only records while
 * armed, around one request plus a short settle window for work the route
 * defers until after its transaction (`runAfterDbContextExit`).
 *
 * The route-only cases below set the agent context directly (as in
 * enrollmentReachability.integration.test.ts), so they isolate each route's
 * own cost. The W0d HTTP cases (#8151) go through the production agent router
 * with a real bearer token, so agentAuthMiddleware's device lookup, limiters,
 * tenant gate and, for routes that are not self-managed, the request-long org
 * transaction are counted too: the full per-request cost every simulated (and
 * real) agent pays. The W0d WS frame cases drive createAgentWsHandlers
 * directly with the context a real upgrade produces (credential hash
 * included), so they count each frame's per-frame credential re-check but not
 * the one-off upgrade.
 *
 * The heartbeat budget is asserted on a STEADY-STATE beat, not on an immediate
 * re-beat: the clock moves 61 s (one beat interval), a sibling device in the
 * same org beats first (so org-wide and global caches are as warm as they are
 * for any org with more than one device), and the device's own Redis policy
 * caches are dropped (their 120 s TTL misses on about every other 60 s beat;
 * this measures the miss). That is the beat production actually pays for.
 *
 * Ratcheted after #8053 W1a-1 (steady 26, warm 20, cold 57 statements; was 69,
 * 47, 96). The remaining bulk is the 9 per-feature policy reads plus the
 * OneDrive context (W1a-2).
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

const recorder = vi.hoisted(() => ({
  recording: false,
  statements: [] as string[],
}));

vi.mock('postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('postgres')>();
  const original = (actual as unknown as { default: (...args: unknown[]) => unknown }).default;
  const wrapped = (...args: unknown[]) => {
    const urlOrOptions = args[0];
    const options = (typeof urlOrOptions === 'string' ? args[1] : urlOrOptions) as
      | { connection?: { application_name?: string } }
      | undefined;
    if (options?.connection?.application_name === 'breeze-api') {
      const instrumented = {
        ...options,
        debug: (_connection: number, query: string) => {
          if (recorder.recording) recorder.statements.push(query);
        },
      };
      return typeof urlOrOptions === 'string'
        ? original(urlOrOptions, instrumented)
        : original(instrumented);
    }
    return original(...args);
  };
  Object.assign(wrapped, original);
  return { ...actual, default: wrapped };
});

// Lets one test make the helper-settings reader fail with a REAL SQL error
// inside the heartbeat's shared policy transaction (see the savepoint test).
const helperFault = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../services/helperSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/helperSettings')>();
  return {
    ...actual,
    buildHelperConfigUpdate: async (...args: Parameters<typeof actual.buildHelperConfigUpdate>) => {
      if (helperFault.enabled) {
        const { db: faultDb } = await import('../../db');
        const { sql: faultSql } = await import('drizzle-orm');
        await faultDb.execute(faultSql`SELECT 1 / 0`); // division_by_zero
      }
      return actual.buildHelperConfigUpdate(...args);
    },
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  enrollmentKeys,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb, getTestRedis } from './setup';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import {
  orgHelperSettingsCache,
  orgPamFallbackCache,
  orgPolicyProbeCache,
} from '../../services/agentOrgSettingsCache';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';
import { unifiTelemetryRoutes } from '../../routes/agents/unifiTelemetry';
import { agentRoutes } from '../../routes/agents';
import { agentAuthMiddleware } from '../../middleware/agentAuth';
import { createAgentWsHandlers } from '../../routes/agentWs';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// One heartbeat interval, plus a second so a TTL of exactly 60 s has expired.
const NEXT_BEAT_MS = 61_000;

/**
 * The route-only steady-state heartbeat transaction count (#8053 test below).
 * The W0d full-chain heartbeat budget must equal it plus agent auth, so both
 * read this one constant (#8142 W03 lowers it to 2).
 */
const ROUTE_ONLY_STEADY_HEARTBEAT_TX = 3;

// Statement buckets (#8053 W1a-1). Each later lever asserts on its own bucket,
// so a regression names itself instead of showing up as "statements 31 > 26".
// Matched on the whitespace-collapsed, lower-cased SQL postgres.js sends.
const BUCKET_MATCHERS = {
  begin: (s: string) => s === 'begin' || s.startsWith('begin '),
  prologue: (s: string) => s.startsWith("select set_config('breeze.scope'"),
  savepoint: (s: string) => s.startsWith('savepoint'),
  // A resolver's own `select … from devices where id = $1` — NOT the core read
  // (which selects every column, agent_token_hash included).
  deviceLookup: (s: string) =>
    /^select .* from "devices" where "devices"\."id" = \$1/.test(s) && !s.includes('"agent_token_hash"'),
  orgPartnerLookup: (s: string) => /^select "partner_id"(, "type")? from "organizations" where/.test(s),
  groupLookup: (s: string) => s.startsWith('select "group_id" from "device_group_memberships"'),
  hierarchyLoad: (s: string) => s.includes('from "devices" left join "organizations"') && s.includes('jsonb_agg'),
  siteLookup: (s: string) => s.includes('from "devices" inner join "sites"'),
  agentVersions: (s: string) => s.includes('from "agent_versions"'),
  topologyNegotiation: (s: string) => s.includes('from devices where id=$1::uuid and not is_ephemeral'),
  orgHelperSettings: (s: string) => s.startsWith('select "settings" from "organizations"'),
  pamOrgConfig: (s: string) => s.includes('from "pam_org_config"'),
  automationPolicies: (s: string) => s.includes('from "automation_policies"'),
  // #8190: the workload-inventory resolver's single policy read. It rides the
  // passed hierarchy (no device/org/group reads of its own) and runs only on a
  // workload settings-cache miss.
  workloadInventoryPolicy: (s: string) => s.includes('"config_policy_workload_inventory_settings"'),
  peripheralCapabilityWrites: (s: string) =>
    s.startsWith('update "device_commands"') || s.startsWith('update "peripheral_policy_device_states"'),
} as const;

type Bucket = keyof typeof BUCKET_MATCHERS;
const BUCKETS = Object.keys(BUCKET_MATCHERS) as Bucket[];

function normalizeStatement(sql: string): string {
  return sql.trim().toLowerCase().replace(/\s+/g, ' ');
}

function classifyStatement(sql: string): Bucket | null {
  const s = normalizeStatement(sql);
  return BUCKETS.find((bucket) => BUCKET_MATCHERS[bucket](s)) ?? null;
}

interface Measurement {
  status: number;
  transactions: number;
  savepoints: number;
  statements: number;
  buckets: Record<Bucket, number>;
}

function summarize(status: number, statements: string[]): Measurement {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const statement of statements) {
    const bucket = classifyStatement(statement);
    if (bucket) buckets[bucket] += 1;
  }
  return {
    status,
    transactions: buckets.begin,
    savepoints: buckets.savepoint,
    statements: statements.length,
    buckets,
  };
}

async function measure(run: () => Promise<Response>): Promise<Measurement> {
  recorder.statements = [];
  recorder.recording = true;
  try {
    const response = await run();
    // Deferred post-transaction work (runAfterDbContextExit) is part of the
    // per-request cost; give it a moment to land before disarming.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (process.env.DUMP_8053) {
      console.log(recorder.statements.map((s, i) => `${i}: ${s.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'));
    }
    return summarize(response.status, recorder.statements);
  } finally {
    recorder.recording = false;
  }
}

// Shifts Date.now() only (cache expiry clocks); real timers and `new Date()`
// are untouched, so the driver and the route behave normally.
let clockOffsetMs = 0;
function advanceClock(ms: number): void {
  clockOffsetMs += ms;
}

async function seedOrg(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `hotpath-${suffix}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: org.id,
      siteId: site.id,
      name: `Hot path ${label}`,
      key: hashEnrollmentKey(rawKey),
      keySecretHash: null,
      usageCount: 0,
      maxUsage: null,
      expiresAt: null,
    });
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, rawKey, suffix };
}

async function seedOrgPolicy(input: {
  orgId: string;
  featureType: 'helper' | 'event_log';
  inlineSettings?: Record<string, unknown>;
  maxEventsPerCycle?: number;
  level: 'device' | 'organization';
  targetId: string;
  roleFilter?: string[];
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.orgId, partnerId: null, name: `hotpath ${input.featureType} ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: input.featureType,
      ...(input.inlineSettings ? { inlineSettings: input.inlineSettings } : {}),
    }).returning();
    if (input.maxEventsPerCycle !== undefined) {
      await db.insert(configPolicyEventLogSettings).values({
        featureLinkId: link!.id, retentionDays: 30, maxEventsPerCycle: input.maxEventsPerCycle,
      });
    }
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: input.level, targetId: input.targetId, priority: 0,
      ...(input.roleFilter ? { roleFilter: input.roleFilter } : {}),
    });
  });
}

type SeededOrg = Awaited<ReturnType<typeof seedOrg>>;

/**
 * #8053: `/agents/enroll` writes its `agent.enroll` audit row fire-and-forget
 * (createAuditLogAsync), as its own transaction on the instrumented request
 * pool, and returns before that write finishes. If it is still in flight when
 * `measure()` arms the recorder, begin/prologue/insert/commit land inside the
 * measured window and inflate (or flake) the budget. Visibility from another
 * session means the audit transaction has COMMITTED, so polling for the row is
 * deterministic, not a sleep. The recorder is unarmed here, so the polls are
 * never counted. Throws on timeout: never proceed with an unsettled enroll.
 */
async function waitForEnrollAuditCommitted(deviceId: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'agent.enroll'), eq(auditLogs.resourceId, deviceId)))
        .limit(1),
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`agent.enroll audit row for device ${deviceId} never became visible (10s)`);
}

async function enrollDevice(org: SeededOrg, hostname: string) {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  const response = await app.request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentKey: org.rawKey,
      hostname: `${hostname}-${org.suffix}`,
      osType: 'linux',
      osVersion: 'Integration Linux',
      architecture: 'amd64',
      agentVersion: '1.0.0-test',
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { deviceId: string; agentId: string; authToken: string };
  await waitForEnrollAuditCommitted(body.deviceId);
  return {
    deviceId: body.deviceId,
    agentId: body.agentId,
    authToken: body.authToken,
    hostname: `${hostname}-${org.suffix}`,
    orgId: org.orgId,
    siteId: org.siteId,
    partnerId: org.partnerId,
  };
}

type EnrolledDevice = Awaited<ReturnType<typeof enrollDevice>>;

function agentApp(device: EnrolledDevice): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: device.deviceId,
      agentId: device.agentId,
      orgId: device.orgId,
      siteId: device.siteId,
      partnerId: device.partnerId,
      role: 'agent',
      isPreAssignment: false,
    } as never);
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  app.route('/agents', unifiTelemetryRoutes);
  return app;
}

// What a current agent declares on every beat: compiledSecurityCapabilities()
// in agent/internal/heartbeat/heartbeat.go (~:7991) plus the runtime PAM
// lifetime version and reconciliation status it sets at ~:4751-4753.
const CURRENT_AGENT_HEARTBEAT = {
  status: 'ok',
  agentVersion: '1.0.0-test',
  metricsAvailable: false,
  securityCapabilities: {
    outboundNetworkPolicyVersion: 1,
    scriptSecretEnvVersion: 1,
    peripheralPolicyProtocolVersion: 2,
    rollbackProtocolVersion: 1,
    revocationLeaseProtocolVersion: 1,
    desktopFenceProtocolVersion: 1,
    desktopWsFenceProtocolVersion: 1,
    consentPromptProtocolVersion: 2,
    pamLifetimeProtocolVersion: 2,
    pamReconciliation: { unresolvedCount: 0, quarantinedCount: 0, awaitingAcknowledgementCount: 0 },
  },
};

// A pre-capability agent (no securityCapabilities). The claim then cancels any
// pending peripheral_policy_sync_v2 rows and marks their states rejected: two
// UPDATEs per beat that a current agent never pays.
const LEGACY_AGENT_HEARTBEAT = { status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false };

function heartbeat(device: EnrolledDevice, body: Record<string, unknown> = CURRENT_AGENT_HEARTBEAT): Promise<Response> {
  return Promise.resolve(agentApp(device).request(`/agents/${device.agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function pollCollectors(device: EnrolledDevice): Promise<Response> {
  return Promise.resolve(agentApp(device).request(`/agents/${device.agentId}/unifi-collectors`, { method: 'GET' }));
}

/** Drop the device's own Redis policy caches (helper, pam, event log, ...). */
async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

// ---------------------------------------------------------------------------
// W0d (#8151) — full per-request DB cost of every request the agent simulator
// (agent/tools/agentsim) sends, agent auth INCLUDED.
// ---------------------------------------------------------------------------

interface Budget {
  transactions: number;
  statements: number;
}

const AUTH_ONLY_SELF_MANAGED = 'agent auth only (self-managed route)';
const AUTH_ONLY_WRAPPED = 'agent auth only (request-long org transaction)';
const COMMAND_RESULT_KEY = 'POST /agents/:id/commands/:commandId/result';
const WS_COMMAND_RESULT_KEY = 'WS command_result';
const WS_PONG_KEY = 'WS pong';

/** Budget keys outside HOT_ROUTES. */
const W0D_EXTRA_KEYS: string[] = [COMMAND_RESULT_KEY, WS_COMMAND_RESULT_KEY, WS_PONG_KEY];

// Declared after the key constants: its computed keys read them.
/**
 * Pinned per-request DB cost, keyed by the simulator's route key
 * (agent/tools/agentsim/sim/routes.go). Both numbers are pinned EXACTLY at
 * the measured steady-state value, not "plus one" and not as a ceiling: one
 * re-introduced per-request read is exactly the regression this gate exists
 * for (a one-statement slack absorbs it), and a drop means either an
 * improvement the ratchet must keep or a handler that stopped doing its work.
 * A change that legitimately moves a number updates it in the same PR and says
 * why. A budget is today's cost, not a blessing of it. agent/tools/agentsim/sim/budget_contract_test.go fails
 * when the simulator gains a route with no entry here.
 */
const HOT_ROUTE_BUDGETS: Record<string, Budget> = {
  // Measured 2026-10-08 on main 551bffd (after #8140 W01, before #8142 W03).
  // Agent auth is 1 tx / 4 statements on every HTTP route below; wrapped
  // routes add the request-long org transaction (1 tx / 3 statements) on top.
  // The WS frame keys bypass HTTP auth (see the WS test).
  [AUTH_ONLY_SELF_MANAGED]: { transactions: 1, statements: 4 },
  [AUTH_ONLY_WRAPPED]: { transactions: 2, statements: 7 },
  // 31 -> 32 (#8190): workload inventory delivery's per-feature policy read
  // (bucket workloadInventoryPolicy), the same +1 the route-only beat takes.
  'POST /agents/:id/heartbeat': { transactions: 4, statements: 32 },
  'GET /agents/:id/unifi-collectors': { transactions: 1, statements: 4 },
  'POST /agents/:id/process-sample': { transactions: 2, statements: 8 },
  'PUT /agents/:id/security/status': { transactions: 2, statements: 10 },
  'PUT /agents/:id/sessions': { transactions: 2, statements: 11 },
  'PUT /agents/:id/software': { transactions: 3, statements: 23 },
  'PUT /agents/:id/disks': { transactions: 2, statements: 12 },
  'PUT /agents/:id/network': { transactions: 2, statements: 13 },
  'PUT /agents/:id/connections': { transactions: 2, statements: 11 },
  'PUT /agents/:id/registry-state': { transactions: 2, statements: 10 },
  'PUT /agents/:id/config-state': { transactions: 2, statements: 10 },
  'PUT /agents/:id/management/posture': { transactions: 2, statements: 9 },
  // Self-managed. getDeviceEventLogSettings is Redis-cached for 120 s, but the
  // agent sends every ~15 min, so steady state is the cache miss: device,
  // org-partner and group reads outside the heartbeat's hierarchy pass-through.
  'PUT /agents/:id/eventlogs': { transactions: 4, statements: 20 },
  [COMMAND_RESULT_KEY]: { transactions: 4, statements: 18 },
  [WS_COMMAND_RESULT_KEY]: { transactions: 4, statements: 17 },
  // The per-frame credential re-check (one system-context device read): a pong
  // arrives every 30 s, past the 5 s re-check lease. The presence refresh
  // itself is Redis-only.
  [WS_PONG_KEY]: { transactions: 1, statements: 4 },
};

function expectWithinBudget(key: string, measured: Measurement): void {
  const budget = HOT_ROUTE_BUDGETS[key];
  const seen = JSON.stringify({ status: measured.status, transactions: measured.transactions, statements: measured.statements });
  expect(budget, `no budget pinned for '${key}' — measured ${seen}`).toBeDefined();
  // Exact, not a ceiling: a drop is either an improvement to ratchet in (lower
  // the pin) or a handler that silently stopped doing its DB work.
  expect(measured.transactions, `'${key}' transactions — measured ${seen}; pinned ${JSON.stringify(budget)}`).toBe(budget!.transactions);
  expect(measured.statements, `'${key}' statements — measured ${seen}; pinned ${JSON.stringify(budget)}`).toBe(budget!.statements);
}

/**
 * Mounted at the production prefix on purpose: agentAuthMiddleware decides
 * self-managed vs. request-long-wrapped routes on the ABSOLUTE path
 * `/api/v1/agents/<id>/<action>` (middleware/agentCorePath.ts). Any other
 * mount wraps every route, heartbeat included, and mis-measures it.
 */
function fullChainApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/agents', agentRoutes);
  return app;
}

function agentRequest(device: EnrolledDevice, method: string, action: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${device.authToken}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return Promise.resolve(fullChainApp().request(`/api/v1/agents/${device.agentId}/${action}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

/**
 * agentAuthMiddleware in front of stub handlers that touch no database, so a
 * measurement is the middleware's own cost. `heartbeat` is in
 * SELF_MANAGED_DB_CONTEXT_ACTIONS (no request-long transaction); `software`
 * is not, so its stub also pays the org transaction every wrapped route pays.
 */
function authOnlyRequest(device: EnrolledDevice, method: 'POST' | 'PUT', action: 'heartbeat' | 'software'): Promise<Response> {
  const app = new Hono();
  app.use('/api/v1/agents/:id/*', agentAuthMiddleware);
  app.post('/api/v1/agents/:id/heartbeat', (c) => c.json({ ok: true }));
  app.put('/api/v1/agents/:id/software', (c) => c.json({ ok: true }));
  return Promise.resolve(app.request(`/api/v1/agents/${device.agentId}/${action}`, {
    method,
    headers: { authorization: `Bearer ${device.authToken}` },
  }));
}

interface HotRoute {
  key: string; // the simulator's route key
  method: 'GET' | 'POST' | 'PUT';
  action: string; // path after /agents/:id/
  intervalMs: number; // the agent's mean interval for this request (plus 1 s)
  body?: (device: EnrolledDevice) => unknown;
}

const nowIso = () => new Date().toISOString();
const minutesAgoIso = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// agentsim's softwareCatalog: 8 named packages padded to 40 items.
const SIM_SOFTWARE_ITEMS = [
  ['openssl', '3.0.13'], ['openssh-server', '9.6p1'], ['curl', '8.5.0'], ['python3', '3.12.3'],
  ['systemd', '255.4'], ['bash', '5.2.21'], ['coreutils', '9.4'], ['git', '2.43.0'],
].map(([name, version]) => ({ name, version, vendor: 'Ubuntu' }))
  .concat(Array.from({ length: 32 }, (_, k) => ({
    name: `libagentsim${String(k + 8).padStart(2, '0')}`, version: `1.0.${k + 8}`, vendor: 'Ubuntu',
  })));

/**
 * Bodies mirror the JSON agent/tools/agentsim/sim/payloads.go marshals (the
 * agent's wire structs where it uses them, otherwise the same map shapes),
 * including the keys the Go structs send without omitempty (rebootStatus,
 * backup*ProtocolVersion: null). registry-state and config-state send what
 * the simulator sends, `entries: [], replace: true`: the delete-only path, so
 * their upsert is not measured here.
 */
const HOT_ROUTES: HotRoute[] = [
  {
    key: 'POST /agents/:id/heartbeat', method: 'POST', action: 'heartbeat', intervalMs: 61_000,
    body: (d) => ({
      metrics: { cpuPercent: 17.2, ramPercent: 57.1, ramUsedMb: 9348, diskPercent: 41.5, diskUsedGb: 207.5, processCount: 200 },
      metricsAvailable: true,
      status: 'ok',
      agentVersion: '1.0.0-test',
      pendingReboot: false,
      rebootStatus: null,
      uptime: 3600,
      backupReadProtocolVersion: null,
      backupIntegrityProtocolVersion: null,
      backupWriteProtocolVersion: null,
      hostname: d.hostname,
      osVersion: 'Ubuntu 24.04 LTS (agentsim)',
      isHeadless: true,
      securityCapabilities: {
        outboundNetworkPolicyVersion: 1, scriptSecretEnvVersion: 1, peripheralPolicyProtocolVersion: 2,
        rollbackProtocolVersion: 1, revocationLeaseProtocolVersion: 1, desktopFenceProtocolVersion: 1,
        desktopWsFenceProtocolVersion: 1, consentPromptProtocolVersion: 2,
      },
    }),
  },
  { key: 'GET /agents/:id/unifi-collectors', method: 'GET', action: 'unifi-collectors', intervalMs: 31_000 },
  {
    key: 'POST /agents/:id/process-sample', method: 'POST', action: 'process-sample', intervalMs: 181_000,
    body: () => ({
      timestamp: nowIso(),
      processes: ['breeze-agent', 'sshd', 'systemd', 'postgres', 'node', 'dockerd', 'containerd', 'chronyd']
        .map((name, i) => ({ name, pid: 100 + i, cpu: 1.5, ramMb: 120 })),
    }),
  },
  {
    key: 'PUT /agents/:id/security/status', method: 'PUT', action: 'security/status', intervalMs: 331_000,
    body: (d) => ({
      deviceId: d.deviceId, deviceName: d.hostname, orgId: d.orgId, os: 'linux',
      provider: 'none', threatCount: 0, firewallEnabled: true, encryptionStatus: 'encrypted',
    }),
  },
  {
    key: 'PUT /agents/:id/sessions', method: 'PUT', action: 'sessions', intervalMs: 331_000,
    body: () => ({
      collectedAt: nowIso(),
      events: [],
      sessions: [{
        username: 'simuser', sessionType: 'ssh', sessionId: '1', loginAt: minutesAgoIso(120), idleMinutes: 3,
        activityState: 'active', isActive: true, lastActivityAt: minutesAgoIso(3), principal: { uid: 1000, username: 'simuser' },
      }],
    }),
  },
  {
    key: 'PUT /agents/:id/software', method: 'PUT', action: 'software', intervalMs: 931_000,
    body: () => ({
      schemaVersion: 2, observationId: randomUUID(), collectorVersion: 'agentsim-1', observedAt: nowIso(),
      completeness: 'complete', expectedSources: ['dpkg'], succeededSources: ['dpkg'], failedSources: [], truncated: false,
      itemCount: SIM_SOFTWARE_ITEMS.length, items: SIM_SOFTWARE_ITEMS,
    }),
  },
  {
    key: 'PUT /agents/:id/disks', method: 'PUT', action: 'disks', intervalMs: 931_000,
    body: () => ({ disks: [{ mountPoint: '/', device: '/dev/sda1', fsType: 'ext4', totalGb: 500, usedGb: 207.5, freeGb: 292.5, usedPercent: 41.5, health: 'healthy' }] }),
  },
  {
    key: 'PUT /agents/:id/network', method: 'PUT', action: 'network', intervalMs: 931_000,
    body: () => ({ adapters: [{ interfaceName: 'eth0', macAddress: '02:42:00:00:00:01', ipAddress: '10.64.0.1', ipType: 'ipv4', isPrimary: true }], vpns: [] }),
  },
  {
    key: 'PUT /agents/:id/connections', method: 'PUT', action: 'connections', intervalMs: 931_000,
    body: () => ({
      connections: ['sshd', 'breeze-agent', 'systemd-resolved', 'chronyd', 'postgres'].map((processName, i) => ({
        protocol: 'tcp', localAddr: '10.64.0.1', localPort: 22 + i, remoteAddr: '10.0.0.1', remotePort: 40000 + i,
        state: 'ESTABLISHED', pid: 800 + i, processName,
      })),
    }),
  },
  { key: 'PUT /agents/:id/registry-state', method: 'PUT', action: 'registry-state', intervalMs: 931_000, body: () => ({ entries: [], replace: true }) },
  { key: 'PUT /agents/:id/config-state', method: 'PUT', action: 'config-state', intervalMs: 931_000, body: () => ({ entries: [], replace: true }) },
  {
    key: 'PUT /agents/:id/management/posture', method: 'PUT', action: 'management/posture', intervalMs: 931_000,
    body: () => ({
      collectedAt: nowIso(), scanDurationMs: 420, categories: {},
      identity: { joinType: 'none', azureAdJoined: false, domainJoined: false, workplaceJoined: false, source: 'agentsim' },
    }),
  },
  {
    key: 'PUT /agents/:id/eventlogs', method: 'PUT', action: 'eventlogs', intervalMs: 931_000,
    body: () => ({
      events: [0, 1, 2].map((i) => ({
        timestamp: minutesAgoIso(i), level: 'info', category: 'system', source: 'systemd',
        eventId: String(1000 + i), message: 'agentsim: periodic system event',
      })),
    }),
  },
];

async function steadyStateMeasure(route: HotRoute, device: EnrolledDevice, sibling: EnrolledDevice): Promise<Measurement> {
  const send = (d: EnrolledDevice) => agentRequest(d, route.method, route.action, route.body?.(d));
  const primed = await send(device); // first-ever send takes insert paths: not steady state
  expect(primed.status, `${route.key} prime`).toBeLessThan(300);
  advanceClock(route.intervalMs);
  const warmed = await send(sibling); // org-wide caches warm, as in any org with more than one device
  expect(warmed.status, `${route.key} sibling`).toBeLessThan(300);
  await dropDeviceRedisCaches(device.deviceId);
  return measureQuiet(() => send(device));
}

type WsStub = Parameters<ReturnType<typeof createAgentWsHandlers>['onMessage']>[1];

/** The server's ping cadence, AGENT_PING_INTERVAL_MS in routes/agentWs.ts; the agent answers each with a pong. */
const WS_PING_INTERVAL_MS = 30_000;

/** A `sent` command row, as dispatch leaves it; written by the uncounted test client. */
async function insertSentCommand(deviceId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({ deviceId, type: 'refresh_inventory', targetRole: 'agent', payload: {}, status: 'sent' })
    .returning({ id: deviceCommands.id });
  if (!row) throw new Error('insertSentCommand: no row');
  return row.id;
}

async function commandStatus(commandId: string): Promise<string | undefined> {
  const [row] = await getTestDb()
    .select({ status: deviceCommands.status })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);
  return row?.status;
}

/** What the simulator's command worker answers (agent.go). */
const commandResultBody = { status: 'completed', exitCode: 0, stdout: 'agentsim' };

/**
 * Wait until the request pool has sent nothing for QUIET_MS, so deferred work
 * from EARLIER requests (fire-and-forget audit writes, runAfterDbContextExit
 * work) cannot land inside the next measured window. Without it a sibling's
 * first-send audit INSERT/COMMIT straddles the window and the count wobbles by
 * one or two statements between runs. Throws rather than measure a busy pool.
 */
async function waitForRequestPoolQuiet(): Promise<void> {
  const QUIET_MS = 150;
  const started = performance.now();
  recorder.statements = [];
  recorder.recording = true;
  try {
    let seen = -1;
    while (performance.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      if (recorder.statements.length === seen) return;
      seen = recorder.statements.length;
    }
    throw new Error(`request pool never went quiet: ${recorder.statements.length} statements in 5 s`);
  } finally {
    recorder.recording = false;
    recorder.statements = [];
  }
}

/** measure(), after earlier requests' deferred work has drained. */
async function measureQuiet(run: () => Promise<Response>): Promise<Measurement> {
  await waitForRequestPoolQuiet();
  return measure(run);
}

describe('agent hot-path DB budget (#8053) — real PostgreSQL', () => {
  beforeEach(() => {
    recorder.recording = false;
    recorder.statements = [];
    clockOffsetMs = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs);
  });
  afterEach(() => {
    recorder.recording = false;
    vi.restoreAllMocks();
  });

  runDb('the request pool is instrumented (guards the budget tests below against a vacuous zero)', async () => {
    const measured = await measure(async () => {
      await withSystemDbAccessContext(async () => { await db.execute('select 1' as never); });
      return new Response(null, { status: 204 });
    });
    expect(measured.transactions).toBe(1);
    expect(measured.statements).toBeGreaterThanOrEqual(3);
  });

  runDb('POST /agents/:id/heartbeat: a steady-state beat stays inside its transaction and statement budget', async () => {
    const org = await seedOrg('heartbeat');
    const device = await enrollDevice(org, 'target');
    const sibling = await enrollDevice(org, 'sibling');

    const cold = await measure(() => heartbeat(device));
    const warm = await measure(() => heartbeat(device));

    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);
    const steady = await measure(() => heartbeat(device));

    console.log(
      '[#8053 budget] heartbeat cold:', JSON.stringify(cold),
      'warm:', JSON.stringify(warm),
      'steady:', JSON.stringify(steady),
    );

    // A current agent declares peripheralPolicyProtocolVersion 2, so the claim
    // never runs the v2 cancel/state UPDATEs that a legacy payload triggers.
    expect(steady.buckets.peripheralCapabilityWrites).toBe(0);

    expect(cold.status).toBe(200);
    expect(warm.status).toBe(200);
    expect(steady.status).toBe(200);
    // #8053 W1a-1 ratchet. Measured after PR A (hierarchy pass-through,
    // topology skip, per-org caches, batched agent_versions):
    //   steady 26 statements / 3 tx (was 69 / 3), warm 20 / 3 (was 47 / 3),
    //   cold 57 / 8 (was 96 / 8; that 96 / 8 figure included a leaked
    //   enroll-audit tx before enrollDevice() waited for it to commit).
    // Pinned at the measured value, not "plus one": any new statement on the
    // beat reds this. If a change legitimately adds one, raise the number in
    // the same PR, name the bucket, and say why. The remaining bulk is the 9
    // per-feature policy reads plus the OneDrive context (W1a-2).
    // 26 -> 27 steady, 57 -> 58 cold (and the miss/legacy shapes below +1): workload
    // inventory delivery (#8190) adds a tenth per-feature policy read,
    // bucket `workloadInventoryPolicy`, on a workload settings-cache miss.
    // Warm is a Redis hit and stays at 20.
    // Cold's one org-partner and one group-membership read are the effective
    // config assignment resolution; warm and steady skip them via hotPathCache.
    expect(steady.transactions).toBe(ROUTE_ONLY_STEADY_HEARTBEAT_TX);
    expect(steady.statements).toBeLessThanOrEqual(27);
    expect(steady.buckets.workloadInventoryPolicy).toBe(1);
    expect(warm.buckets.workloadInventoryPolicy).toBe(0);
    expect(warm.transactions).toBe(3);
    expect(warm.statements).toBeLessThanOrEqual(20);
    expect(cold.transactions).toBeLessThanOrEqual(8);
    expect(cold.statements).toBeLessThanOrEqual(58); // 57 + workloadInventoryPolicy (#8190)
    expect(cold.buckets.hierarchyLoad).toBe(1);
    expect(cold.buckets.deviceLookup).toBe(0);
    expect(cold.buckets.topologyNegotiation).toBe(0);
    expect(cold.buckets.agentVersions).toBe(1);

    // #8053 W1a-1 lever 1: one hierarchy read replaces 33 per-resolver reads.
    expect(steady.buckets.hierarchyLoad).toBe(1);
    expect(steady.buckets.deviceLookup).toBe(0);
    expect(steady.buckets.orgPartnerLookup).toBe(0);
    expect(steady.buckets.groupLookup).toBe(0);
    expect(steady.buckets.siteLookup).toBe(0);
    expect(warm.buckets.hierarchyLoad).toBe(1);
    expect(warm.buckets.deviceLookup).toBe(0);

    // Lever 2: materialization is off for this org, so no negotiation runs.
    expect(steady.buckets.topologyNegotiation).toBe(0);
    expect(warm.buckets.topologyNegotiation).toBe(0);

    // Lever 3: the sibling's beat warmed the org's probe, helper-legacy and PAM
    // caches, so this beat reads none of them.
    expect(steady.buckets.automationPolicies).toBe(0);
    expect(steady.buckets.orgHelperSettings).toBe(0);
    expect(steady.buckets.pamOrgConfig).toBe(0);
    // Agent, helper and watchdog offers share one agent_versions read.
    expect(steady.buckets.agentVersions).toBe(1);
    expect(warm.buckets.agentVersions).toBe(1);
    // Lever 6: the claim's savepoint + the helper miss's; no probe savepoint.
    expect(steady.savepoints).toBe(2);
    // Warm: helper is a Redis hit (no savepoint), probe a process-cache hit.
    expect(warm.savepoints).toBe(1);
  });

  runDb('POST /agents/:id/heartbeat: a beat whose per-org caches (probe, helper legacy, PAM fallback) all miss — e.g. a single-device org — still costs 3 transactions; a miss loads inside the existing system context', async () => {
    const org = await seedOrg('permiss');
    const device = await enrollDevice(org, 'target');
    const sibling = await enrollDevice(org, 'sibling');
    expect((await heartbeat(device)).status).toBe(200);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);
    // Miss ONLY the three per-org caches this wave added; everything else stays warm.
    orgPolicyProbeCache.invalidate(org.orgId);
    orgHelperSettingsCache.invalidate(org.orgId);
    orgPamFallbackCache.invalidate(org.orgId);
    const missed = await measure(() => heartbeat(device));
    console.log('[#8053 budget] per-org caches all miss:', JSON.stringify(missed));

    expect(missed.status).toBe(200);
    expect(missed.transactions).toBe(3);
    expect(missed.buckets.automationPolicies).toBe(1);
    expect(missed.buckets.orgHelperSettings).toBe(1);
    expect(missed.buckets.pamOrgConfig).toBe(1);
    expect(missed.statements).toBeLessThanOrEqual(31); // 30 + workloadInventoryPolicy (#8190)
  });

  runDb('POST /agents/:id/heartbeat: a legacy (no securityCapabilities) beat pays the two peripheral-v2 UPDATEs on top', async () => {
    const org = await seedOrg('legacy');
    const device = await enrollDevice(org, 'legacy');
    const sibling = await enrollDevice(org, 'legacy-sibling');
    await heartbeat(device, LEGACY_AGENT_HEARTBEAT);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling, LEGACY_AGENT_HEARTBEAT)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);
    const steady = await measure(() => heartbeat(device, LEGACY_AGENT_HEARTBEAT));
    console.log('[#8053 budget] legacy steady:', JSON.stringify(steady));

    expect(steady.status).toBe(200);
    expect(steady.transactions).toBeLessThanOrEqual(3);
    expect(steady.buckets.peripheralCapabilityWrites).toBe(2);
    expect(steady.statements).toBeLessThanOrEqual(29); // 28 + workloadInventoryPolicy (#8190)
  });

  runDb('a real SQL error in the helper reader stays inside its savepoint: the shared policy transaction still commits', async () => {
    const org = await seedOrg('savepoint');
    const device = await enrollDevice(org, 'faulty');
    helperFault.enabled = true;
    try {
      const measured = await measure(() => heartbeat(device));
      expect(measured.status).toBe(200);
      // The failed statement rolled back to its savepoint...
      expect(recorder.statements.some((s) => /^rollback to /i.test(s.trim()))).toBe(true);
    } finally {
      helperFault.enabled = false;
    }
    // ...so every resolver after it still ran in a live transaction. Without the
    // savepoint, the division_by_zero would abort the shared transaction, every
    // later resolver would fail, and patch_source_settings (always present on a
    // successful resolve, `false` with no policy) would be omitted.
    helperFault.enabled = true;
    try {
      const res = await heartbeat(device);
      const body = await res.json() as { helperEnabled: boolean; configUpdate: Record<string, unknown> | null };
      expect(body.helperEnabled).toBe(false);
      expect(body.configUpdate?.patch_source_settings).toEqual({ exclusiveWindowsUpdate: false });
    } finally {
      helperFault.enabled = false;
    }
  });

  runDb('GET /agents/:id/unifi-collectors: a device with no collectors costs one probe, then nothing until the TTL', async () => {
    const org = await seedOrg('collectors');
    const device = await enrollDevice(org, 'poller');

    const cold = await measure(() => pollCollectors(device));
    const warm = await measure(() => pollCollectors(device));
    advanceClock(NEXT_BEAT_MS);
    const nextPoll = await measure(() => pollCollectors(device));
    console.log(
      '[#8053 budget] unifi-collectors cold:', JSON.stringify(cold),
      'warm:', JSON.stringify(warm),
      'next minute:', JSON.stringify(nextPoll),
    );

    expect(cold.status).toBe(200);
    expect(warm.status).toBe(200);
    expect(await (await pollCollectors(device)).json()).toEqual({ collectors: [] });
    expect(cold.transactions).toBeLessThanOrEqual(1);
    expect(cold.statements).toBeLessThanOrEqual(4);
    expect(warm.transactions).toBe(0);
    expect(warm.statements).toBe(0);
    expect(nextPoll.statements).toBe(0);
  });

  it('W0d: the budget table pins exactly the simulator routes and the auth-only cases', () => {
    const expected = [...HOT_ROUTES.map((r) => r.key), ...W0D_EXTRA_KEYS, AUTH_ONLY_SELF_MANAGED, AUTH_ONLY_WRAPPED].sort();
    expect(Object.keys(HOT_ROUTE_BUDGETS).sort()).toEqual(expected);
  });

  runDb('W0d: agentAuthMiddleware alone stays inside its budget on both route classes', async () => {
    const org = await seedOrg('w0d-auth');
    const device = await enrollDevice(org, 'auth-target');
    const sibling = await enrollDevice(org, 'auth-sibling');
    // Org-wide caches (tenant state, org device count) warm, as for any org with more than one device.
    expect((await authOnlyRequest(sibling, 'POST', 'heartbeat')).status).toBe(200);
    const cold = await measureQuiet(() => authOnlyRequest(device, 'POST', 'heartbeat'));
    const selfManaged = await measureQuiet(() => authOnlyRequest(device, 'POST', 'heartbeat'));
    const wrapped = await measureQuiet(() => authOnlyRequest(device, 'PUT', 'software'));
    console.log(
      '[W0d budget] agent auth cold:', JSON.stringify(cold),
      'self-managed:', JSON.stringify(selfManaged),
      'wrapped:', JSON.stringify(wrapped),
    );
    expect(selfManaged.status).toBe(200);
    expect(wrapped.status).toBe(200);
    // The device lookup is unconditional: zero means the middleware never ran.
    expect(selfManaged.statements).toBeGreaterThan(0);
    // The request-long org transaction (opened eagerly by withDbAccessContext)
    // is exactly what separates the two route classes.
    expect(wrapped.transactions).toBe(selfManaged.transactions + 1);
    expectWithinBudget(AUTH_ONLY_SELF_MANAGED, selfManaged);
    expectWithinBudget(AUTH_ONLY_WRAPPED, wrapped);
  });

  for (const route of HOT_ROUTES) {
    runDb(`W0d ${route.key}: a steady-state request, agent auth included, stays inside its budget`, async () => {
      const org = await seedOrg(`w0d-${route.action.replace(/\//g, '-')}`);
      const device = await enrollDevice(org, 'target');
      const sibling = await enrollDevice(org, 'sibling');
      const measured = await steadyStateMeasure(route, device, sibling);
      console.log('[W0d budget]', route.key, JSON.stringify(measured));
      expect(measured.status).toBeLessThan(300);
      // Agent auth's device lookup is unconditional: zero statements means the
      // request never reached the database and the budget would be vacuous.
      expect(measured.statements).toBeGreaterThan(0);
      expectWithinBudget(route.key, measured);
    });
  }

  it('W0d: the full-chain heartbeat transaction budget is the route-only beat plus agent auth', () => {
    const fullChain = HOT_ROUTE_BUDGETS['POST /agents/:id/heartbeat'];
    const auth = HOT_ROUTE_BUDGETS[AUTH_ONLY_SELF_MANAGED];
    expect(fullChain, 'heartbeat budget pinned').toBeDefined();
    expect(auth, 'auth-only budget pinned').toBeDefined();
    expect(fullChain!.transactions).toBe(ROUTE_ONLY_STEADY_HEARTBEAT_TX + auth!.transactions);
  });

  runDb(`W0d ${COMMAND_RESULT_KEY}: the HTTP fallback result, agent auth included, stays inside its budget`, async () => {
    const org = await seedOrg('w0d-cmd-http');
    const device = await enrollDevice(org, 'target');
    const sibling = await enrollDevice(org, 'sibling');
    const primed = await agentRequest(device, 'POST', `commands/${await insertSentCommand(device.deviceId)}/result`, commandResultBody);
    expect(primed.status).toBeLessThan(300);
    advanceClock(WS_PING_INTERVAL_MS);
    const warm = await agentRequest(sibling, 'POST', `commands/${await insertSentCommand(sibling.deviceId)}/result`, commandResultBody);
    expect(warm.status).toBeLessThan(300);
    const commandId = await insertSentCommand(device.deviceId);
    const measured = await measureQuiet(() => agentRequest(device, 'POST', `commands/${commandId}/result`, commandResultBody));
    console.log('[W0d budget]', COMMAND_RESULT_KEY, JSON.stringify(measured));
    expect(measured.status).toBeLessThan(300);
    expect(await commandStatus(commandId)).toBe('completed'); // accepted, not short-circuited
    expect(measured.statements).toBeGreaterThan(0);
    expectWithinBudget(COMMAND_RESULT_KEY, measured);
  });

  runDb('W0d WS frames: a pong and a command_result stay inside their budgets', async () => {
    const org = await seedOrg('w0d-ws');
    const device = await enrollDevice(org, 'ws-target');
    // The context a real upgrade produces (agentWs.ts validateAgentWsToken):
    // with credentialTokenHash set, every frame after the re-check lease
    // re-authorizes the credential, exactly as on a production socket.
    const handlers = createAgentWsHandlers(device.agentId, {
      deviceId: device.deviceId,
      orgId: device.orgId,
      partnerId: device.partnerId,
      credentialTokenHash: createHash('sha256').update(device.authToken).digest('hex'),
    });
    const ws = { send: vi.fn(), close: vi.fn() } as unknown as WsStub;
    const frame = async (data: unknown): Promise<Response> => {
      await handlers.onMessage({ data: JSON.stringify(data) } as MessageEvent, ws);
      return new Response(null, { status: 204 });
    };
    const presenceKey = `agent-presence:${device.agentId}`;
    const redis = getTestRedis();
    await handlers.onOpen({}, ws);
    try {
      expect(await redis.exists(presenceKey), 'onOpen took the presence lease').toBe(1);
      await frame({ type: 'pong', timestamp: Date.now() }); // the first frame after open is not steady state
      // Steady state: the agent answers the server's ping every 30 s, well
      // past AGENT_CREDENTIAL_RECHECK_TTL_MS (5 s), so each pong re-checks.
      advanceClock(WS_PING_INTERVAL_MS);
      // Shorten the lease (just before measuring) so the pong's refresh is
      // observable: a pong the handler silently dropped would otherwise
      // measure only the credential re-check and pass.
      await waitForRequestPoolQuiet();
      await redis.pexpire(presenceKey, 1_000);
      const pong = await measure(() => frame({ type: 'pong', timestamp: Date.now() }));
      expect(await redis.pttl(presenceKey), 'the pong refreshed the presence lease').toBeGreaterThan(1_000);

      const commandId = await insertSentCommand(device.deviceId);
      advanceClock(WS_PING_INTERVAL_MS);
      const result = await measureQuiet(() => frame({ type: 'command_result', commandId, ...commandResultBody }));
      console.log('[W0d budget] ws pong:', JSON.stringify(pong), 'ws command_result:', JSON.stringify(result));
      expect(await commandStatus(commandId)).toBe('completed');
      expect((ws as unknown as { close: ReturnType<typeof vi.fn> }).close, 'the credential re-check passed').not.toHaveBeenCalled();
      expectWithinBudget(WS_PONG_KEY, pong);
      expectWithinBudget(WS_COMMAND_RESULT_KEY, result);
    } finally {
      await handlers.onClose({}, ws);
    }
  });
});

describe('heartbeat hierarchy pass-through (#8053 W1a-1) — behaviour guards, real PostgreSQL', () => {
  // These pass BEFORE and AFTER the change: they pin today's behaviour so the
  // pass-through cannot alter what an agent receives.

  runDb('a sibling\'s device-level helper policy never reaches another device in the same org', async () => {
    const org = await seedOrg('isolation');
    const device = await enrollDevice(org, 'plain');
    const sibling = await enrollDevice(org, 'helper-on');
    await seedOrgPolicy({
      orgId: org.orgId, featureType: 'helper', inlineSettings: { enabled: true },
      level: 'device', targetId: sibling.deviceId,
    });

    const siblingBody = await (await heartbeat(sibling)).json() as { helperEnabled: boolean };
    const deviceBody = await (await heartbeat(device)).json() as { helperEnabled: boolean };
    expect(siblingBody.helperEnabled).toBe(true);
    expect(deviceBody.helperEnabled).toBe(false);
  });

  runDb('a role this very beat writes is the role the policy resolvers see', async () => {
    const org = await seedOrg('role');
    const device = await enrollDevice(org, 'role');
    await seedOrgPolicy({
      orgId: org.orgId, featureType: 'event_log', maxEventsPerCycle: 777,
      level: 'organization', targetId: org.orgId, roleFilter: ['printer'],
    });

    const res = await heartbeat(device, { ...CURRENT_AGENT_HEARTBEAT, deviceRole: 'printer' });
    expect(res.status).toBe(200);
    const body = await res.json() as { configUpdate: { event_log_settings?: { max_events_per_cycle: number } } };
    expect(body.configUpdate.event_log_settings?.max_events_per_cycle).toBe(777);
  });
});
