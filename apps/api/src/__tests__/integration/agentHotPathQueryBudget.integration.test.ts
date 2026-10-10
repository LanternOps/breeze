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
 * Ratcheted after #8053 W1a-1 (steady 26 / 3 tx, warm 20 / 3, cold 57 / 8) and
 * again after #8142 W03 (steady 14 / 2 tx, warm 14 / 2): one org-scoped
 * post-commit context instead of the OneDrive + shared system contexts, and
 * one policy-set read instead of ten per-feature assignment reads.
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, or, sql } from 'drizzle-orm';

const recorder = vi.hoisted(() => ({
  recording: false,
  statements: [] as string[],
  params: [] as unknown[][],
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
        debug: (_connection: number, query: string, params?: unknown[]) => {
          if (recorder.recording) {
            recorder.statements.push(query);
            recorder.params.push(params ?? []);
          }
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

// Lets a test make a helper read fail with a REAL SQL error inside the
// heartbeat's shared policy transaction (see the savepoint tests):
//  - 'org-flag': the legacy org flag read, the only helper SQL on the policy-set path;
//  - 'builder':  the whole helper builder, which reads its own on the no-set path.
const helperFault = vi.hoisted(() => ({ mode: null as null | 'org-flag' | 'builder' }));
// Forces the policy-set load to fail with a real SQL error (the "set error" path).
const policySetFault = vi.hoisted(() => ({ enabled: false }));
async function divideByZero(): Promise<void> {
  const { db: faultDb } = await import('../../db');
  const { sql: faultSql } = await import('drizzle-orm');
  await faultDb.execute(faultSql`SELECT 1 / 0`); // division_by_zero
}
vi.mock('../../services/helperSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/helperSettings')>();
  return {
    ...actual,
    getOrgHelperSettings: async (...args: Parameters<typeof actual.getOrgHelperSettings>) => {
      if (helperFault.mode === 'org-flag') await divideByZero();
      return actual.getOrgHelperSettings(...args);
    },
    buildHelperConfigUpdate: async (...args: Parameters<typeof actual.buildHelperConfigUpdate>) => {
      if (helperFault.mode === 'builder') await divideByZero();
      return actual.buildHelperConfigUpdate(...args);
    },
  };
});
vi.mock('../../services/devicePolicySet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/devicePolicySet')>();
  return {
    ...actual,
    loadDevicePolicySet: async (...args: Parameters<typeof actual.loadDevicePolicySet>) => {
      if (policySetFault.enabled) await divideByZero();
      return actual.loadDevicePolicySet(...args);
    },
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  automationPolicies,
  organizations,
  pamOrgConfig,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  enrollmentKeys,
  m365Connections,
  onedriveDeviceState,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { policySetQuery } from '../../services/devicePolicySet';
import {
  buildEventLogConfigUpdate, buildHardwareMonitoringConfigUpdate, buildHelperConfigUpdate,
  buildMonitoringConfigUpdate, buildPamConfigUpdate, buildPatchSourceConfigUpdate,
  buildTimeSyncConfigUpdate, buildWarrantyConfigUpdate, loadOnedriveHelperConfigPlan,
} from '../../routes/agents/helpers';
import { encryptSecret } from '../../services/secretCrypto';
import { clearGroupMembershipCache } from '../../services/onedriveGraph';
import { clearTokenCache } from '../../services/m365DirectGraph';
import { seedPolicy, type SeedLink } from './policySetFixtures';
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
 * read this one constant (#8142 W03 lowered it from 3).
 */
const ROUTE_ONLY_STEADY_HEARTBEAT_TX = 2;
// #8142 — measured in Task 9 and pinned.
const COLD_TX = 7;
const COLD_STATEMENTS = 47;
const CACHES_MISS_STATEMENTS = 20;
const CONFIGURED_STEADY_STATEMENTS = 21;

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
  // #8142: the one-statement policy set, and anything that still reads
  // assignments per feature (must be 0 on every beat shape with a set).
  policySetLoad: (s: string) =>
    s.includes('from "config_policy_assignments"') && s.includes('left join "config_policy_effective_feature_links"'),
  perFeatureAssignmentRead: (s: string) =>
    s.includes('"config_policy_assignments"') && !s.includes('left join "config_policy_effective_feature_links"'),
  // Monitoring's raw-link secondaries (intervals, attachments, replace links) and definitions.
  monitoringSecondary: (s: string) =>
    s.includes('from "config_policy_feature_links"') || s.includes('from "monitor_definitions"'),
  onedriveRead: (s: string) =>
    s.includes('from "config_policy_onedrive_libraries"') || s.includes('from "onedrive_device_state"') || s.includes('from "m365_connections"'),
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
  recorder.params = [];
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
  // #8142 W03 (2026-10-10): one policy-set read in one org-scoped post-commit
  // context. Was 4 tx / 31 statements.
  'POST /agents/:id/heartbeat': { transactions: 3, statements: 19 },
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
    // #8142 W03 ratchet. Measured after the batched policy read:
    //   steady 14 statements / 2 tx (was 26 / 3), warm 14 / 2 (was 20 / 3),
    //   cold 47 / 7 (was 57 / 8).
    // Pinned at the measured value, not "plus one": a new statement reds this.
    expect(steady.transactions).toBe(ROUTE_ONLY_STEADY_HEARTBEAT_TX);
    expect(steady.statements).toBeLessThanOrEqual(14);
    expect(warm.transactions).toBe(2);
    expect(warm.statements).toBeLessThanOrEqual(14);
    expect(cold.transactions).toBeLessThanOrEqual(COLD_TX);
    expect(cold.statements).toBeLessThanOrEqual(COLD_STATEMENTS);
    expect(cold.buckets.hierarchyLoad).toBe(1);
    expect(cold.buckets.deviceLookup).toBe(0);
    expect(cold.buckets.topologyNegotiation).toBe(0);
    expect(cold.buckets.agentVersions).toBe(1);
    // Cold has the set, plus exactly ONE other assignment read: the org block's
    // effective-config assignment resolution (cold only; warm and steady skip it
    // via hotPathCache). It is not a per-feature policy read.
    expect(cold.buckets.policySetLoad).toBe(1);
    expect(cold.buckets.perFeatureAssignmentRead).toBe(1);

    // W1a-1 levers stay pulled: one hierarchy read replaces 33 per-resolver
    // reads, on the steady AND the warm beat.
    expect(steady.buckets.hierarchyLoad).toBe(1);
    expect(steady.buckets.deviceLookup).toBe(0);
    expect(warm.buckets.hierarchyLoad).toBe(1);
    expect(warm.buckets.deviceLookup).toBe(0);
    expect(steady.buckets.orgPartnerLookup).toBe(0);
    expect(steady.buckets.groupLookup).toBe(0);
    expect(steady.buckets.siteLookup).toBe(0);
    // Materialization is off for this org, so no topology negotiation runs.
    expect(steady.buckets.topologyNegotiation).toBe(0);
    expect(warm.buckets.topologyNegotiation).toBe(0);
    // The sibling's beat warmed the org's probe, helper-legacy and PAM caches,
    // so this beat reads none of them.
    expect(steady.buckets.automationPolicies).toBe(0);
    expect(steady.buckets.orgHelperSettings).toBe(0);
    expect(steady.buckets.pamOrgConfig).toBe(0);
    expect(steady.buckets.agentVersions).toBe(1);
    expect(warm.buckets.agentVersions).toBe(1);

    // #8142 levers: one policy-set read, no per-feature assignment reads, and a
    // device with no monitors / OneDrive link pays nothing for either.
    for (const beat of [steady, warm]) {
      expect(beat.buckets.policySetLoad).toBe(1);
      expect(beat.buckets.perFeatureAssignmentRead).toBe(0);
      expect(beat.buckets.monitoringSecondary).toBe(0);
      expect(beat.buckets.onedriveRead).toBe(0);
      // The claim's savepoint + the hierarchy/set savepoint. The helper resolves
      // from the set in memory (no savepoint), the probe is a cache hit.
      expect(beat.savepoints).toBe(2);
    }
  });

  runDb('POST /agents/:id/heartbeat: a beat whose per-org caches (probe, helper legacy, PAM fallback) all miss — e.g. a single-device org — still costs 2 transactions; each miss loads in its own savepoint inside the policy context', async () => {
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
    expect(missed.transactions).toBe(2);
    expect(missed.buckets.automationPolicies).toBe(1);
    expect(missed.buckets.orgHelperSettings).toBe(1);
    expect(missed.buckets.pamOrgConfig).toBe(1);
    expect(missed.buckets.policySetLoad).toBe(1);
    expect(missed.buckets.perFeatureAssignmentRead).toBe(0);
    expect(missed.statements).toBeLessThanOrEqual(CACHES_MISS_STATEMENTS);
  });

  runDb('POST /agents/:id/heartbeat: the org-scoped cache-miss beat STORES the full probe, helper-flag and PAM-fallback values for the org (#8142)', async () => {
    const org = await seedOrg('fillvalues');
    const device = await enrollDevice(org, 'filler');
    const rules = (n: string) => [{ type: 'registry_check', registryPath: `HKLM\\Software\\${n}`, registryValueName: n }];
    await withSystemDbAccessContext(async () => {
      const targets = { targetType: 'all', targetIds: [] };
      await db.insert(automationPolicies).values([
        { orgId: null, partnerId: org.partnerId, name: 'pw', targets, rules: rules('PartnerWide') },
        { orgId: org.orgId, partnerId: null, name: 'own', targets, rules: rules('OrgOwn') },
      ] as never);
      await db.update(organizations).set({ settings: { helper: { enabled: true } } }).where(eq(organizations.id, org.orgId));
      await db.insert(pamOrgConfig).values({ orgId: org.orgId, uacInterceptionEnabled: true } as never);
    });
    // Control: nothing is cached for this fresh org before the beat.
    expect(orgPolicyProbeCache.peek(org.orgId)).toBeUndefined();
    expect(orgHelperSettingsCache.peek(org.orgId)).toBeUndefined();
    expect(orgPamFallbackCache.peek(org.orgId)).toBeUndefined();

    expect((await heartbeat(device)).status).toBe(200);

    const probe = orgPolicyProbeCache.peek(org.orgId);
    expect(probe?.policy_config_state_probes).toEqual([]);
    expect((probe?.policy_registry_state_probes ?? []).map((p) => p.value_name).sort()).toEqual(['OrgOwn', 'PartnerWide']);
    expect(orgHelperSettingsCache.peek(org.orgId)).toEqual({ enabled: true });
    expect(orgPamFallbackCache.peek(org.orgId)).toEqual({ uacInterceptionEnabled: true });
  });

  runDb('POST /agents/:id/heartbeat: the OneDrive Graph phase (real getToken + membership chain) holds no transaction and issues no DB statement (#8142)', async () => {
    const org = await seedOrg('graphphase');
    const device = await enrollDevice(org, 'graph');
    const GROUP_ID = '0f0f0f0f-aaaa-4bbb-8ccc-000000000001';
    const TENANT_ID = '11111111-2222-4333-8444-555555555555';
    await seedPolicy({ owner: { orgId: org.orgId, partnerId: null },
      links: [{ featureType: 'onedrive_helper', orgId: org.orgId, filesOnDemand: true, libraryName: 'Graph Docs', graphGroupId: GROUP_ID }],
      assignments: [{ level: 'organization', targetId: org.orgId }] });
    await withSystemDbAccessContext(async () => {
      await db.insert(onedriveDeviceState).values({
        deviceId: device.deviceId, orgId: org.orgId, signedIn: true, signedInUpns: ['member@contoso.example'],
      } as never);
      await db.insert(m365Connections).values({
        orgId: org.orgId, tenantId: TENANT_ID, clientId: 'graph-phase-client',
        clientSecret: encryptSecret('graph-phase-secret'),
        profile: 'legacy-direct', authMode: 'client-secret-legacy', credentialDomain: 'legacy-direct',
        vaultRef: null, credentialVersion: null, permissionManifestVersion: 0, observedGrants: [],
        status: 'active',
      } as never);
    });
    clearGroupMembershipCache();
    clearTokenCache();

    // Stub ONLY the two Microsoft hosts; record, at each outbound call, how many
    // statements the request pool has seen and how many transactions are still open.
    const realFetch = globalThis.fetch.bind(globalThis);
    const calls: Array<{ url: string; statements: number; openTransactions: number }> = [];
    const openTransactions = () => recorder.statements
      .map(normalizeStatement)
      .reduce((n, s) => n + (s === 'begin' || s.startsWith('begin ') ? 1 : 0) - (s === 'commit' || s === 'rollback' ? 1 : 0), 0);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url ?? String(input);
      if (url.startsWith('https://login.microsoftonline.com/') || url.startsWith('https://graph.microsoft.com/')) {
        calls.push({ url, statements: recorder.statements.length, openTransactions: openTransactions() });
        const body = url.includes('/oauth2/v2.0/token')
          ? { access_token: 'graph-phase-token', expires_in: 3600 }
          : { value: [{ id: GROUP_ID }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    });

    let responseBody: any;
    const beat = await measure(async () => {
      const res = await heartbeat(device);
      responseBody = await res.clone().json();
      return res;
    });
    expect(beat.status).toBe(200);

    // The phase really ran: a token call and a membership call, in that order, and the
    // library was tagged for the member (the chain produced its output).
    expect(calls.map((c) => c.url.includes('/oauth2/v2.0/token') ? 'token' : 'graph')).toEqual(['token', 'graph']);
    expect(responseBody.configUpdate.onedrive_helper_settings.libraries[0].allowedUpns).toEqual(['member@contoso.example']);
    // No pooled connection is held across either Microsoft call (#1105) ...
    expect(calls.map((c) => c.openTransactions)).toEqual([0, 0]);
    // ... the policy context's COMMIT is the last statement before the first call
    // (nothing is read between the context and the Graph phase) ...
    expect(normalizeStatement(recorder.statements[calls[0]!.statements - 1]!)).toBe('commit');
    // ... and the DB is not touched between the two calls (the whole chain is DB-free).
    expect(calls[1]!.statements).toBe(calls[0]!.statements);
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
    expect(steady.transactions).toBe(2);
    expect(steady.buckets.peripheralCapabilityWrites).toBe(2);
    expect(steady.buckets.policySetLoad).toBe(1);
    expect(steady.buckets.perFeatureAssignmentRead).toBe(0);
    expect(steady.statements).toBeLessThanOrEqual(16);
  });

  // Both guards assert the same invariant from two directions: a REAL SQL error
  // inside the shared policy transaction stays inside a savepoint, so every
  // resolver after it still runs in a live transaction. Without the savepoint
  // the division_by_zero aborts the shared transaction, later resolvers fail,
  // and patch_source_settings (always present on a successful resolve, `false`
  // with no policy) would be omitted.
  runDb('a real SQL error in the helper legacy org-flag read (policy-set path) stays inside its savepoint (#8142)', async () => {
    const org = await seedOrg('savepoint-org');
    const device = await enrollDevice(org, 'faulty');
    // The org flag is read only on a per-org cache miss; make sure it misses.
    orgHelperSettingsCache.invalidate(org.orgId);
    await dropDeviceRedisCaches(device.deviceId);
    helperFault.mode = 'org-flag';
    try {
      let body: Record<string, any> = {};
      const measured = await measure(async () => {
        const res = await heartbeat(device);
        body = await res.clone().json() as Record<string, any>;
        return res;
      });
      expect(measured.status).toBe(200);
      // The set loaded (this IS the set path) and the failed statement rolled back to its savepoint...
      expect(measured.buckets.policySetLoad).toBe(1);
      expect(recorder.statements.some((s) => /^rollback to /i.test(s.trim()))).toBe(true);
      // ...so the resolvers after it still delivered.
      expect(body.helperEnabled).toBe(false);
      expect(body.configUpdate?.patch_source_settings).toEqual({ exclusiveWindowsUpdate: false });
    } finally {
      helperFault.mode = null;
    }
  });

  runDb('when the policy-set load fails, the resolvers read their own and a real SQL error in the helper reader stays in its savepoint (#8142)', async () => {
    const org = await seedOrg('savepoint-noset');
    const device = await enrollDevice(org, 'faulty-noset');
    await dropDeviceRedisCaches(device.deviceId);
    policySetFault.enabled = true;
    helperFault.mode = 'builder';
    try {
      let body: Record<string, any> = {};
      const measured = await measure(async () => {
        const res = await heartbeat(device);
        body = await res.clone().json() as Record<string, any>;
        return res;
      });
      expect(measured.status).toBe(200);
      // Two distinct rollbacks: the failed set load and the failed helper read.
      expect(recorder.statements.filter((s) => /^rollback to /i.test(s.trim())).length).toBeGreaterThanOrEqual(2);
      // No set was produced; the resolvers fell back to their own reads.
      expect(measured.buckets.policySetLoad).toBe(0);
      expect(measured.buckets.perFeatureAssignmentRead).toBeGreaterThan(0);
      expect(body.helperEnabled).toBe(false);
      expect(body.configUpdate?.patch_source_settings).toEqual({ exclusiveWindowsUpdate: false });
    } finally {
      policySetFault.enabled = false;
      helperFault.mode = null;
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

  const CONFIGURED_LINKS = (orgId: string): SeedLink[] => [
    { featureType: 'helper', inlineSettings: { enabled: true } },
    { featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } },
    { featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 } },
    { featureType: 'event_log', maxEventsPerCycle: 250 },
    { featureType: 'hardware_monitoring', pollIntervalMinutes: 15 },
    { featureType: 'patch', exclusiveWindowsUpdate: true },
    { featureType: 'time_sync', ntpServers: ['time.budget.example'] },
    { featureType: 'monitors', serviceName: 'BudgetService', checkIntervalSeconds: 90 },
    { featureType: 'onedrive_helper', orgId, filesOnDemand: true, libraryName: 'Budget Docs' },
  ];

  runDb('POST /agents/:id/heartbeat: a device configured for EVERY feature stays at 2 transactions (#8142)', async () => {
    const org = await seedOrg('configured');
    const device = await enrollDevice(org, 'configured');
    const sibling = await enrollDevice(org, 'configured-sibling');
    await seedPolicy({ owner: { orgId: org.orgId, partnerId: null }, links: CONFIGURED_LINKS(org.orgId),
      assignments: [{ level: 'organization', targetId: org.orgId }] });
    expect((await heartbeat(device)).status).toBe(200);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);

    let body: Record<string, any> = {};
    const steady = await measure(async () => {
      const res = await heartbeat(device);
      body = await res.clone().json() as Record<string, any>;
      return res;
    });
    console.log('[#8142 budget] configured steady:', JSON.stringify(steady));

    // Non-vacuous: every feature really resolved from the policy.
    expect(body.helperEnabled).toBe(true);
    expect(body.uacInterceptionEnabled).toBe(true);
    expect(body.configUpdate.event_log_settings.max_events_per_cycle).toBe(250);
    expect(body.configUpdate.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
    expect(body.configUpdate.monitoring_settings).toMatchObject({ check_interval_seconds: 90, watches: [expect.objectContaining({ name: 'BudgetService' })] });
    expect(body.configUpdate.onedrive_helper_settings.libraries).toHaveLength(1);

    expect(steady.transactions).toBe(2);
    expect(steady.buckets.policySetLoad).toBe(1);
    expect(steady.buckets.perFeatureAssignmentRead).toBe(0);
    expect(steady.statements).toBeLessThanOrEqual(CONFIGURED_STEADY_STATEMENTS);
  });

  runDb('a device whose only policy is PAM pays no monitoring statement and still gets the explicit clear (#8142)', async () => {
    const org = await seedOrg('pamonly');
    const device = await enrollDevice(org, 'pamonly');
    const sibling = await enrollDevice(org, 'pamonly-sibling');
    await seedPolicy({ owner: { orgId: org.orgId, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
      assignments: [{ level: 'organization', targetId: org.orgId }] });
    expect((await heartbeat(device)).status).toBe(200);
    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);

    let body: Record<string, any> = {};
    const steady = await measure(async () => {
      const res = await heartbeat(device);
      body = await res.clone().json() as Record<string, any>;
      return res;
    });
    expect(body.uacInterceptionEnabled).toBe(true);
    expect(body.configUpdate.monitoring_settings).toEqual({ check_interval_seconds: 60, watches: [] });
    expect(steady.buckets.monitoringSecondary).toBe(0);
    expect(steady.transactions).toBe(2);
    expect(steady.statements).toBeLessThanOrEqual(14);
  });

  runDb('cross-tenant assignments forged onto this device never reach its heartbeat (#8142)', async () => {
    const org = await seedOrg('forge');
    const device = await enrollDevice(org, 'forge-target');
    const samePartnerOtherOrg = (await createOrganization({ partnerId: org.partnerId }))!;
    const foreignPartner = (await createPartner())!;
    await seedPolicy({ owner: { orgId: samePartnerOtherOrg.id, partnerId: null },
      links: [{ featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://forged.example' } }],
      assignments: [{ level: 'device', targetId: device.deviceId }], forgeAssignments: true });
    await seedPolicy({ owner: { orgId: null, partnerId: foreignPartner.id },
      links: [{ featureType: 'event_log', maxEventsPerCycle: 999 }],
      assignments: [{ level: 'partner', targetId: org.partnerId, priority: -10 }], forgeAssignments: true });

    // Non-vacuity: the forged rows really exist (system scope sees them), so
    // the assertions below pass because RLS hides them, not because seeding failed.
    const forged = await withSystemDbAccessContext(() =>
      db.select({ policyId: configPolicyAssignments.configPolicyId, level: configPolicyAssignments.level })
        .from(configPolicyAssignments)
        .where(or(
          and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, device.deviceId)),
          and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId)),
        )));
    expect(forged.map((r) => r.level).sort()).toEqual(['device', 'partner']);

    const res = await heartbeat(device);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.helperEnabled).toBe(false);
    expect(body.helperSettings?.portalUrl).toBeUndefined();
    expect(body.configUpdate.event_log_settings.max_events_per_cycle).toBe(100);
  });

  // Inlines postgres.js parameters as SQL literals so a captured statement can be re-run under EXPLAIN.
  const literal = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(',')}]::text[]`;
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const inline = (query: string, params: unknown[]): string =>
    query.replace(/\$(\d+)/g, (_m, n: string) => literal(params[Number(n) - 1]));
  const planText = (rows: unknown): string =>
    (rows as Array<Record<string, string>>).map((r) => r['QUERY PLAN']).join('\n');
  const execMs = (text: string): number => Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? NaN);

  it.runIf(!!process.env.DATABASE_URL && !!process.env.EXPLAIN_8142)(
    'perf probe: EXPLAIN (ANALYZE, BUFFERS) of the policy-set statement as breeze_app, configured device (#8142)',
    async () => {
      const org = await seedOrg('explain');
      const device = await enrollDevice(org, 'explain');
      await seedPolicy({ owner: { orgId: org.orgId, partnerId: null }, links: CONFIGURED_LINKS(org.orgId),
        assignments: [{ level: 'organization', targetId: org.orgId }] });
      await withDbAccessContext({
        scope: 'organization', orgId: org.orgId, accessibleOrgIds: [org.orgId], accessiblePartnerIds: [],
        userId: null, currentPartnerId: org.partnerId,
      }, async () => {
        // Evidence that this runs as the unprivileged app role under the org-scoped RLS context.
        const who = (await db.execute(sql`SELECT current_user AS u, current_setting('breeze.scope', true) AS scope,
          current_setting('breeze.org_id', true) AS org, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass`)) as unknown as Array<Record<string, unknown>>;
        console.log('[#8142 probe] role/scope:', JSON.stringify(who[0]));
        expect(who[0]!.u).toBe('breeze_app');
        expect(who[0]!.bypass).toBe(false);
        expect(who[0]!.scope).toBe('organization');

        const hierarchy = (await loadDeviceHierarchy(device.deviceId))!;
        const setPlan = planText(await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${policySetQuery(hierarchy)}`));
        console.log(`[#8142 probe] POLICY-SET STATEMENT PLAN\n${setPlan}`);

        // Legacy: each resolver WITHOUT a policySet issues its own per-feature statement(s).
        recorder.statements = [];
        recorder.params = [];
        recorder.recording = true;
        try {
          await buildHelperConfigUpdate(device.deviceId, org.orgId, { skipCacheRead: true } as never);
          await buildEventLogConfigUpdate(device.deviceId);
          await buildHardwareMonitoringConfigUpdate(device.deviceId);
          await buildPamConfigUpdate(device.deviceId);
          await buildPatchSourceConfigUpdate(device.deviceId);
          await buildWarrantyConfigUpdate(device.deviceId);
          await buildTimeSyncConfigUpdate(device.deviceId);
          await buildMonitoringConfigUpdate(device.deviceId);
          await loadOnedriveHelperConfigPlan(device.deviceId);
        } finally {
          recorder.recording = false;
        }
        const captured = recorder.statements
          .map((q, i) => ({ q, p: recorder.params[i] ?? [] }))
          .filter(({ q }) => /"config_policy_assignments"/i.test(q));
        // Non-vacuity: ten legacy per-feature statements (the policy-set replaces exactly these).
        expect(captured.length).toBe(10);
        let legacyTotal = 0;
        for (const [i, { q, p }] of captured.entries()) {
          const t = planText(await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${inline(q, p)}`)));
          const ms = execMs(t);
          legacyTotal += ms;
          console.log(`[#8142 probe] LEGACY STATEMENT ${i + 1}/${captured.length} (${ms} ms): ${q.replace(/\s+/g, ' ').slice(0, 110)}...\n${t}`);
        }
        console.log(`[#8142 probe] legacy per-feature assignment statements: ${captured.length}, summed Execution Time ${legacyTotal.toFixed(3)} ms; set statement Execution Time ${execMs(setPlan)} ms`);
      });
    },
  );
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
