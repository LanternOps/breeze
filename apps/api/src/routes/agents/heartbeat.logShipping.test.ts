import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------- mocks ----------

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const runOutsideDbContextMock = vi.fn(async (fn: () => unknown) => fn());
const ingestRollbackObservationMock = vi.hoisted(() => vi.fn());

// Records the order of key lifecycle events so a test can assert the
// manifest-trust-keyset fetch happens AFTER the org DB context closes
// (the #1105 pool-poison fix). Reset per test.
const callOrder: string[] = [];
// #4673 W02 — org contexts opened by the heartbeat's self-managed wrap.
const orgDbContexts: Array<Record<string, unknown>> = [];

// #5876 — work the heartbeat defers until its DB context exits. Runs inline by
// default; the recovery-marker suite captures it instead so it can assert the
// enqueue happens only after the context is gone.
const afterExit: Array<() => unknown> = [];
const runAfterDbContextExitDefault = (_label: string, work: () => unknown) => { work(); };
const runAfterDbContextExitMock = vi.fn(runAfterDbContextExitDefault);

const recordAgentHealthObservationMock = vi.hoisted(() => vi.fn(async (_input: unknown) => ({
  observationId: 'health-observation-1',
  becameLatest: true,
})));

// Default pass-through behaviour for withSystemDbAccessContext — extracted so
// it can be reinstalled via mockImplementationOnce for calls a test doesn't
// care about, while a specific call (targeted by ordering) is made to reject.
// A `vi.fn()` (rather than a bare async function) is required so a test can
// override ONE of the withSystemDbAccessContext call sites in heartbeat.ts
// (agent-update-policy lookup, topology flags) without touching the others.
// Since #8142 the post-commit policy work runs in the org-scoped
// withDbAccessContext seam below, not here.
const systemDbAccessContextPassthrough = async (fn: () => Promise<unknown>) => {
  callOrder.push('systemCtx:enter');
  const result = await fn();
  callOrder.push('systemCtx:exit');
  return result;
};
const withSystemDbAccessContextMock = vi.fn(systemDbAccessContextPassthrough);
// #8142 — the post-commit policy context is now the SECOND org-scoped context
// of a beat; a vi.fn so a test can fail exactly that call.
const orgDbAccessContextPassthrough = async (ctx: unknown, fn: () => Promise<unknown>) => {
  orgDbContexts.push(ctx as Record<string, unknown>);
  callOrder.push('dbContext:opened');
  const result = await fn();
  callOrder.push('dbContext:released');
  return result;
};
const withDbAccessContextMock = vi.fn(orgDbAccessContextPassthrough);

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) =>
    runOutsideDbContextMock(...(args as [any])),
  // #8053 W1a-1 — DeferredCacheFills / HotPathTtlCache consult these. The
  // mock reports a system scope, so unit fills are always cacheable; the
  // org-scoped fill rule (#8142) is proven against real Postgres in
  // agentHotPathQueryBudget.integration.test.ts. No ambient context at flush.
  hasDbAccessContext: () => false,
  getCurrentDbAccessContext: () => ({ scope: 'system' }),
  runAfterDbContextExit: (label: string, work: () => unknown) => runAfterDbContextExitMock(label, work),
  // Pass-through that records when the org-scoped context opens and when its
  // callback resolves — in production the org transaction is released at the
  // latter point.
  // #4673 W02 — also RECORDS the context object. The heartbeat is in
  // SELF_MANAGED_DB_CONTEXT_ACTIONS, so it skips agentAuthMiddleware's
  // request-long wrap and hand-builds this context itself; the only way to
  // prove it copies `currentPartnerId` across from the agent context is to
  // inspect what it passed.
  withDbAccessContext: (...args: unknown[]) => withDbAccessContextMock(...(args as [unknown, () => Promise<unknown>])),
  // Pass-through by default: the effective agent-update-policy lookup (#2123,
  // BEFORE the org block) and the topology flags run in a system context.
  // Invoke the callback so the mocked
  // resolvers still run, and record enter/exit so tests can assert ordering
  // relative to the org context. A `vi.fn()` so an individual test can swap in
  // a rejection for exactly one call site via mockImplementationOnce.
  withSystemDbAccessContext: (...args: unknown[]) =>
    withSystemDbAccessContextMock(...(args as [() => Promise<unknown>])),
  // #8053 / #8142 — SQL-issuing readers in the post-commit policy context run
  // in savepoints; a savepoint is a pass-through here.
  withDbTransaction: async (fn: () => Promise<unknown>) => {
    callOrder.push('savepoint');
    return fn();
  },
}));

vi.mock('../../db/schema', () => ({
  bareMetalRecoveries: {
    id: 'bare_metal_recoveries.id',
    orgId: 'bare_metal_recoveries.org_id',
    deviceId: 'bare_metal_recoveries.device_id',
    snapshotId: 'bare_metal_recoveries.snapshot_id',
    identity: 'bare_metal_recoveries.identity',
    nonceHash: 'bare_metal_recoveries.nonce_hash',
    status: 'bare_metal_recoveries.status',
    rebootedAt: 'bare_metal_recoveries.rebooted_at',
    checkedInAt: 'bare_metal_recoveries.checked_in_at',
    updatedAt: 'bare_metal_recoveries.updated_at',
  },
  devices: {
    id: 'devices.id',
    status: 'devices.status',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
    hostname: 'devices.hostname',
    osType: 'devices.os_type',
    osVersion: 'devices.os_version',
    osBuild: 'devices.os_build',
    architecture: 'devices.architecture',
    agentVersion: 'devices.agent_version',
    deviceRole: 'devices.device_role',
    deviceRoleSource: 'devices.device_role_source',
    desktopAccess: 'devices.desktop_access',
    tccPermissions: 'devices.tcc_permissions',
    isHeadless: 'devices.is_headless',
    watchdogStatus: 'devices.watchdog_status',
    watchdogLastSeen: 'devices.watchdog_last_seen',
    watchdogVersion: 'devices.watchdog_version',
    mainAgentSilentSince: 'devices.main_agent_silent_since',
    lastSeenAt: 'devices.last_seen_at',
    agentTokenHash: 'devices.agent_token_hash',
    tokenIssuedAt: 'devices.token_issued_at',
  },
  deviceMetrics: { deviceId: 'device_metrics.device_id' },
  // #3409 PR4c-2 — the real services/commandDelivery runs here, and its
  // secret-delivery claim gate touches these three tables when it withholds
  // an envelope-bearing command.
  deviceCommands: {
    id: 'device_commands.id',
    status: 'device_commands.status',
    payload: 'device_commands.payload',
  },
  scriptExecutions: {
    id: 'script_executions.id',
    deviceId: 'script_executions.device_id',
    status: 'script_executions.status',
    scriptId: 'script_executions.script_id',
  },
  scriptExecutionBatches: {
    id: 'script_execution_batches.id',
    scriptId: 'script_execution_batches.script_id',
    devicesFailed: 'script_execution_batches.devices_failed',
  },
  agentLogs: { deviceId: 'agent_logs.device_id' },
  agentVersions: {
    platform: 'agent_versions.platform',
    architecture: 'agent_versions.architecture',
    component: 'agent_versions.component',
    isLatest: 'agent_versions.is_latest',
    version: 'agent_versions.version',
    createdAt: 'agent_versions.created_at',
  },
  // Resolved via a dynamic import inside PUT /:id/monitoring-results.
  serviceProcessCheckResults: {
    orgId: 'service_process_check_results.org_id',
    deviceId: 'service_process_check_results.device_id',
    details: 'service_process_check_results.details',
  },
}));

// Same route dynamically imports getRedis; null disables the failure-counter
// branch so the test focuses on what is persisted.
vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => null),
}));

// Heartbeat schema is large — bypass it by stubbing the validator to make
// the parsed body available via c.req.valid('json') without running real
// zod parsing. The schema's contents aren't what we're testing.
vi.mock('./schemas', () => ({
  heartbeatSchema: {} as any,
}));
vi.mock('@hono/zod-validator', () => ({
  zValidator: () => async (c: any, next: any) => {
    const data = await c.req.json().catch(() => ({}));
    // Patch c.req.valid so the route handler reads through to our raw body.
    const origValid = c.req.valid?.bind(c.req);
    c.req.valid = (_target: string) => data;
    try {
      await next();
    } finally {
      if (origValid) c.req.valid = origValid;
    }
  },
}));

vi.mock('./helpers', () => ({
  maybeQueueThresholdFilesystemAnalysis: vi.fn(),
  buildPolicyProbeConfigUpdate: vi.fn(() => undefined),
  normalizeAgentArchitecture: vi.fn((s: string) => s),
  compareAgentVersions: vi.fn(() => 0),
  buildEventLogConfigUpdate: vi.fn(() => undefined),
  buildHardwareMonitoringConfigUpdate: vi.fn(),
  buildTimeSyncConfigUpdate: vi.fn(),
  buildWorkloadInventoryConfigUpdate: vi.fn(),
  buildMonitoringConfigUpdate: vi.fn(() => undefined),
  buildHelperConfigUpdate: vi.fn(() => undefined),
  // #8053 W1a-1 — the heartbeat reads the Redis entry itself and hands the org
  // loaders in; default to "no cached entry / flag off / PAM fallback off".
  readCachedHelperSettings: vi.fn(async () => null),
  getOrgHelperSettings: vi.fn(async () => ({ enabled: false })),
  resolveOrgPamFallback: vi.fn(async () => ({ uacInterceptionEnabled: false })),
  buildPamConfigUpdate: vi.fn(async () => ({ uacInterceptionEnabled: false })),
  buildPatchSourceConfigUpdate: vi.fn(async () => ({ exclusiveWindowsUpdate: false })),
  // Default OFF, mirroring buildPatchSourceConfigUpdate: every heartbeat test
  // that does not care about warranty still exercises the delivery merge rather
  // than the builder-throws path.
  buildWarrantyConfigUpdate: vi.fn(async () => ({ hpCmslEnabled: false })),
  // Null = no onedrive policy for the device. Tests that exercise delivery
  // override this per-test. Omitting it entirely would make every heartbeat
  // test silently exercise only the builder-throws path (undefined is not a
  // function) — which is how the delivery merge went untested pre-#2322-review.
  buildOnedriveHelperConfigUpdate: vi.fn(async () => null),
  // #8142 — OneDrive is split: a DB phase inside the policy context, a Graph
  // phase after it commits. Null plan = no onedrive policy for the device.
  loadOnedriveHelperConfigPlan: vi.fn(async () => null),
  finishOnedriveHelperConfig: vi.fn(async () => null),
  // Permissive default (staged + no window = upgrade anytime) and no version
  // pins (issue #2124), so the upgrade gating is transparent to tests that don't
  // care about the org policy. The heartbeat resolves BOTH from this one call.
  getOrgAgentUpdateConfig: vi.fn(async () => ({
    settings: { policy: 'staged', maintenanceWindow: null },
    pins: { agent: null, watchdog: null },
  })),
  // #8053 — the heartbeat reads the cached wrapper. Modelled as an uncached
  // pass-through with the real wrapper's shape (its own system context around
  // getOrgAgentUpdateConfig), so per-test overrides of getOrgAgentUpdateConfig
  // keep working; the cache itself is covered in helpers.agentUpdatePolicy.test.ts.
  getOrgAgentUpdateConfigCached: async (orgId: string) => {
    const helpers = await import('./helpers');
    return withSystemDbAccessContextMock(() => helpers.getOrgAgentUpdateConfig(orgId));
  },
  // Default target mirrors the `selectMock` '0.66.0' convention used across the
  // upgrade tests: the resolver returns the candidate target version, and the
  // gate + compareAgentVersions (default 0 = no newer) decide whether to send it.
  resolvePinnedUpgradeTarget: vi.fn(async () => '0.66.0'),
  // #8053 W1a-1 — the heartbeat's batched read, modelled as the three single
  // calls it replaces (agent, helper, watchdog — the order the blocks ran).
  resolvePinnedUpgradeTargets: async (args: {
    platform: string; architecture: string; agentId?: string;
    requests: Array<{ component: string; pin: string | null }>;
  }) => {
    const helpers = await import('./helpers');
    const out = new Map<string, string | null>();
    for (const r of args.requests) {
      out.set(r.component, await helpers.resolvePinnedUpgradeTarget({
        component: r.component, platform: args.platform, architecture: args.architecture, pin: r.pin, agentId: args.agentId,
      }));
    }
    return out;
  },
  // #4072 — permissive default so the edition gate is transparent to tests
  // that don't exercise it. The edition-gate describe overrides per-test and
  // restores this implementation in afterEach (clearAllMocks does not).
  agentAcceptsServedEdition: vi.fn(() => true),
  // Mirrors the real helper: only a flip INTO 'server' from a different role
  // is withheld from auto-apply; every other transition passes through.
  shouldAutoApplyAgentReportedDeviceRole: vi.fn((current: string | null | undefined, reported: string) =>
    reported !== 'server' || current === 'server'),
}));

const refreshReadinessMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/bareMetalReadinessRefresh', () => ({
  refreshReadinessAfterRecovery: refreshReadinessMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/deviceIpHistory', () => ({
  processDeviceIPHistoryUpdate: vi.fn(),
}));

const claimPendingCommandsForDeviceMock = vi.fn(async (): Promise<unknown[]> => []);
const releaseClaimedCommandDeliveryMock = vi.fn(async () => undefined);

// Only claim/release are mocked; the batch decrypt-and-release helper
// (services/commandDelivery, #2414) runs for real so the heartbeat tests below
// exercise the actual release-on-decrypt-failure behavior.
vi.mock('../../services/commandDispatch', () => ({
  claimPendingCommandsForDevice: (...args: unknown[]) =>
    claimPendingCommandsForDeviceMock(...(args as [])),
  releaseClaimedCommandDelivery: (...args: unknown[]) =>
    releaseClaimedCommandDeliveryMock(...(args as [])),
}));

vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn(async () => undefined),
}));

vi.mock('../../services/agentRollbackResult', () => ({
  ingestRollbackObservation: ingestRollbackObservationMock,
}));

const { promotePendingAgentCredentialsMock } = vi.hoisted(() => ({
  promotePendingAgentCredentialsMock: vi.fn(),
}));
vi.mock('../../services/agentTokenPromotion', () => ({
  promotePendingAgentCredentials: promotePendingAgentCredentialsMock,
  PREVIOUS_TOKEN_GRACE_MS: 5 * 60 * 1000,
}));

vi.mock('../../middleware/agentAuth', () => ({
  isAgentTokenRotationDue: vi.fn(() => false),
  // #3986 — the ONE definition of the drain claim allowlist. heartbeat.ts reads
  // it as the fail-closed fallback for `agent.claimTypeAllowlist`, so the mock
  // must carry the real value or the fallback would silently mean
  // "unrestricted" in every test.
  DRAIN_CLAIM_TYPE_ALLOWLIST: ['self_uninstall'] as const,
}));

// #7970 — the UniFi collector presence probe. A real (registered, so reset per
// test) TTL cache; only the SQL probe is a mock.
const deviceHasAgentCollectorsMock = vi.hoisted(() => vi.fn(async (_db: unknown, _deviceId: string, _orgId: string) => false));
vi.mock('../../services/unifi/unifiCollectorService', async () => {
  const { HotPathTtlCache } = await import('../../services/hotPathCache');
  return {
    agentCollectorAbsenceCache: new HotPathTtlCache<string, boolean>({ name: 'unifi-agent-collector-absence', ttlMs: 300_000, maxEntries: 100 }),
    agentCollectorAbsenceKey: (deviceId: string, orgId: string) => `${orgId}:${deviceId}`,
    deviceHasAgentCollectors: deviceHasAgentCollectorsMock,
  };
});

vi.mock('../../services/agentEditionAutoMigrate', () => ({
  maybeDispatchEditionMigration: vi.fn().mockResolvedValue(undefined),
  // Permissive default so the launch-gating tests below control it explicitly.
  shouldConsiderEditionMigration: vi.fn(() => true),
}));

const { loadTopologyFlagsMock, withResolvedTopologyFlagsMock } = vi.hoisted(() => ({
  loadTopologyFlagsMock: vi.fn(),
  withResolvedTopologyFlagsMock: vi.fn(),
}));
vi.mock('../../services/topology/flags', () => ({
  loadTopologyFlags: (...args: unknown[]) => loadTopologyFlagsMock(...args),
  // #8053 — uncached pass-through with the real wrapper's shape (own system
  // context, org-only scope).
  loadAgentTopologyFlags: (orgId: string) =>
    withSystemDbAccessContextMock(() => loadTopologyFlagsMock({ scope: { orgId } }) as Promise<unknown>),
  withResolvedTopologyFlags: (...args: unknown[]) => withResolvedTopologyFlagsMock(...args),
}));

// #8053 W1a-1 / #8142 — the hierarchy is loaded first in the post-commit policy
// context. By default it is the authenticated device's own (org-1 / partner-1),
// so every builder runs; tests override it to exercise the skip paths.
const TEST_HIERARCHY = vi.hoisted(() => ({
  deviceId: 'device-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
  org: { partnerId: 'partner-1', type: 'customer' }, site: null, groupIds: [] as string[],
}));
vi.mock('../../services/deviceHierarchy', () => ({
  loadDeviceHierarchy: vi.fn(async (deviceId: string) => ({ ...TEST_HIERARCHY, deviceId })),
  withHierarchy: (h: unknown) => (h ? { hierarchy: h } : undefined),
}));
vi.mock('../../services/devicePolicySet', () => ({
  loadDevicePolicySet: vi.fn(async () => null),
  withPolicySet: (set: { hierarchy: unknown } | null, h: unknown) =>
    (set ? { hierarchy: set.hierarchy, policySet: set } : h ? { hierarchy: h } : undefined),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/agentHealthObservations', () => ({
  recordAgentHealthObservation: (...args: unknown[]) =>
    recordAgentHealthObservationMock(...(args as [any])),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS: 180_000,
  resolveRemoteAccessForDevice: vi.fn(async () => ({
    helperEnabled: false,
    helperSettings: null,
    manageRemoteManagement: false,
  })),
}));

const getActiveTrustKeysetMock = vi.fn();
const getActiveManifestKeyDelegationsMock = vi.fn();

// #8053 — the heartbeat reads the cached variants; the cache itself is covered
// in manifestSigning.test.ts.
vi.mock('../../services/manifestSigning', () => ({
  getActiveTrustKeysetCached: (...args: unknown[]) => {
    callOrder.push('trustKeyset:fetched');
    return getActiveTrustKeysetMock(...(args as []));
  },
  getActiveManifestKeyDelegationsCached: (...args: unknown[]) => {
    callOrder.push('delegations:fetched');
    return getActiveManifestKeyDelegationsMock(...(args as []));
  },
}));

// #8317 — only the signer is replaced; the capability and needs-sync decisions
// run for real (they are unit-tested in agentIdentityAssertion.test.ts).
const signAgentIdentityAssertionMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/agentIdentityAssertion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agentIdentityAssertion')>()),
  signAgentIdentityAssertion: (...args: unknown[]) => {
    callOrder.push('identity:signed');
    return signAgentIdentityAssertionMock(...args);
  },
}));

// `routes/metrics` is mocked rather than loaded: heartbeat.ts imports
// `recordAgentHeartbeat` from it directly (as routes/agents/helpers.ts already
// did), and pulling the real module in would drag the whole metrics + db graph
// into this suite. `resolveResponseStatus` keeps its real behaviour, since the
// success/failed split depends on it.
const recordAgentHeartbeatMock = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({
  recordAgentHeartbeat: recordAgentHeartbeatMock,
  resolveResponseStatus: (c: any) => (c?.finalized ? (c.res?.status ?? 500) : 500),
}));

// #4630 — the heartbeat's dynamic-group re-evaluation ENQUEUE site. The
// evaluation itself never runs on the request path any more; the handler only
// hands the device id to the coalescing BullMQ queue.
const requestDeviceGroupReevaluationMock = vi.hoisted(() => vi.fn().mockResolvedValue('job-1'));
vi.mock('../../jobs/deviceGroupJobs', () => ({
  requestDeviceGroupReevaluation: requestDeviceGroupReevaluationMock,
}));

vi.mock('../../services/reliabilityBaselines', () => ({ createReliabilityBaseline: vi.fn() }));
vi.mock('../../jobs/reliabilityWorker', () => ({ enqueueDeviceReliabilityComputation: vi.fn() }));

import { and, eq, notInArray } from 'drizzle-orm';
import { heartbeatRoutes, tccPermissionsMeaningfullyChanged } from './heartbeat';
import { devices, bareMetalRecoveries } from '../../db/schema';
import { hashRecoveryNonce } from '../../services/bareMetalRecoveryCodes';
import { createReliabilityBaseline } from '../../services/reliabilityBaselines';
import { enqueueDeviceReliabilityComputation } from '../../jobs/reliabilityWorker';
import { __resetHotPathCachesForTests } from '../../services/hotPathCacheRegistry';

// Otherwise a probe/helper value cached by one test is served to the next for the same org.
beforeEach(() => { __resetHotPathCachesForTests(); });

// Builds a thenable mock-chain so any `.from().where().limit()` access
// resolves to the given value.
function selectChainResolving(value: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(value),
        orderBy: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(value),
        })),
      })),
    })),
  };
}

// A `where(...)` result for the db.update chain that is BOTH awaitable (the
// watchdog-branch update and any caller that ignores the result) AND carries a
// `.returning()` method (the guarded main-branch update reads back whether a
// row actually changed — finding #10 state-transition audit). `returningRows`
// defaults to one row so the guarded write reads as "took effect"; pass `[]` to
// model a terminal-status device whose guarded update matched 0 rows.
function whereResultWithReturning(returningRows: unknown[] = [{ id: 'device-1' }]) {
  const result: Promise<undefined> & { returning?: ReturnType<typeof vi.fn> } =
    Promise.resolve(undefined);
  result.returning = vi.fn().mockResolvedValue(returningRows);
  return result;
}

function buildApp(agentOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      siteId: 'site-1',
      role: 'agent',
      ...agentOverrides,
    });
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

function buildWatchdogApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      siteId: 'site-1',
      role: 'watchdog',
    });
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

// #2774 — an offboarding tenant's agent authenticates but is narrowed to
// self_uninstall delivery. agentAuthMiddleware sets `tenantDraining`.
function buildDrainingApp(role: 'agent' | 'watchdog' = 'agent'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      siteId: 'site-1',
      role,
      tenantDraining: true,
      // #3986 — the real middleware derives this ONCE and every claim site
      // reads it; the harness must mirror that or it would be testing a
      // context shape production never produces.
      claimTypeAllowlist: ['self_uninstall'] as const,
    });
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

// #3986 — a REMOVED device inside the device-remove uninstall drain window.
// Distinct from buildDrainingApp (a healthy device on an OFFBOARDING TENANT):
// this one is the machine itself being uninstalled, and it gets the minimal
// drain beat rather than a full heartbeat.
function buildDeviceDrainApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      siteId: 'site-1',
      role: 'agent',
      tenantDraining: false,
      deviceUninstallDraining: true,
      claimTypeAllowlist: ['self_uninstall'] as const,
    });
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

const minimalHeartbeatBody = {
  agentVersion: '0.65.10',
  metrics: {
    cpuPercent: 5,
    ramPercent: 10,
    ramUsedMb: 1024,
    diskPercent: 15,
    diskUsedGb: 30,
  },
};

const healthObservation = {
  schemaVersion: 1,
  deviceId: 'device-1',
  agentVersion: '0.65.10',
  overall: 'warning',
  metricsAvailable: true,
  components: {
    metrics: { state: 'warning', reason: 'disk pressure' },
  },
  observedAt: '2026-08-24T12:00:00.000Z',
};

const originalAgentBackupServerUrl = process.env.AGENT_BACKUP_SERVER_URL;
const originalAgentRequireManifestSigningKeyId = process.env.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID;

afterEach(() => {
  if (originalAgentBackupServerUrl === undefined) {
    delete process.env.AGENT_BACKUP_SERVER_URL;
  } else {
    process.env.AGENT_BACKUP_SERVER_URL = originalAgentBackupServerUrl;
  }
  if (originalAgentRequireManifestSigningKeyId === undefined) {
    delete process.env.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID;
  } else {
    process.env.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID = originalAgentRequireManifestSigningKeyId;
  }
});


// Log-shipping health W01 (#8608 / #8607). Dormant ingest: the heartbeat
// persists the agent's `logShipping` classification on TRANSITION ONLY into the
// devices row that the beat already UPDATEs. The harness above is copied from
// heartbeat.test.ts; the cases below are the write-amplification contract.
describe('POST /agents/:id/heartbeat — log-shipping health persistence (#8608)', () => {
  const agentDeviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'windows',
    osVersion: 'Windows 11',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.105.1',
    deviceRole: 'workstation',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    mainAgentSilentSince: null,
    status: 'online',
    logShippingState: null,
    logShippingFailureStartedAt: null,
    logShippingLastError: null,
  };
  const LS_KEYS = ['logShippingState', 'logShippingFailureStartedAt', 'logShippingLastError'];

  beforeEach(async () => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    const { agentAcceptsServedEdition, compareAgentVersions } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => true);
    vi.mocked(compareAgentVersions).mockReturnValue(0);
  });

  function primeWithRow(row: Record<string, unknown>) {
    selectMock.mockReturnValueOnce(selectChainResolving([{ ...agentDeviceRow, ...row }]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
  }
  function captureSet() {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    return setSpy;
  }
  const setCalls = (spy: ReturnType<typeof captureSet>) =>
    spy.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
  const lsKeysIn = (spy: ReturnType<typeof captureSet>) =>
    setCalls(spy).flatMap((s) => Object.keys(s).filter((k) => LS_KEYS.includes(k)));

  async function beat(extra: Record<string, unknown> = {}) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, agentVersion: '0.105.1', ...extra }),
    });
  }
  const shipping = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    queueDepth: 0,
    droppedLogs: 0,
    ...over,
  });

  it('old agent (no logShipping) on a fresh device adds none of the three keys', async () => {
    const setSpy = captureSet();
    primeWithRow({});
    expect((await beat()).status).toBe(200);
    expect(lsKeysIn(setSpy)).toEqual([]);
  });

  it('quiet report on a fresh device writes the state only', async () => {
    const setSpy = captureSet();
    primeWithRow({});
    expect((await beat({ logShipping: shipping() })).status).toBe(200);
    const found = setCalls(setSpy).find((s) => 'logShippingState' in s);
    expect(found?.logShippingState).toBe('quiet');
    expect(found).not.toHaveProperty('logShippingFailureStartedAt');
    expect(found).not.toHaveProperty('logShippingLastError');
  });

  it('steady-state ok -> ok adds zero keys (no per-beat write)', async () => {
    const setSpy = captureSet();
    primeWithRow({ logShippingState: 'ok' });
    expect((await beat({ logShipping: shipping({ lastAttemptOk: true }) })).status).toBe(200);
    expect(lsKeysIn(setSpy)).toEqual([]);
  });

  it('ok -> failing stamps state, episode start and error in ONE .set() payload', async () => {
    const setSpy = captureSet();
    primeWithRow({ logShippingState: 'ok' });
    expect(
      (await beat({ logShipping: shipping({ lastAttemptOk: false, lastError: 'http 503' }) })).status,
    ).toBe(200);
    const withAny = setCalls(setSpy).filter((s) => Object.keys(s).some((k) => LS_KEYS.includes(k)));
    expect(withAny).toHaveLength(1);
    expect(withAny[0]!.logShippingState).toBe('failing');
    expect(withAny[0]!.logShippingFailureStartedAt).toBeInstanceOf(Date);
    expect(withAny[0]!.logShippingLastError).toBe('http 503');
    // No dedicated log-shipping statement: every .set() that exists is a
    // pre-existing beat statement, and the new keys ride one of them.
    expect(setCalls(setSpy).filter((s) => Object.keys(s).every((k) => LS_KEYS.includes(k)))).toHaveLength(0);
  });

  it('failing -> failing with the same error adds zero keys', async () => {
    const setSpy = captureSet();
    primeWithRow({
      logShippingState: 'failing',
      logShippingFailureStartedAt: new Date('2026-10-12T10:00:00Z'),
      logShippingLastError: 'http 503',
    });
    expect(
      (await beat({ logShipping: shipping({ lastAttemptOk: false, lastError: 'http 503' }) })).status,
    ).toBe(200);
    expect(lsKeysIn(setSpy)).toEqual([]);
  });

  it('field omitted on a previously-reporting device resets all three to null', async () => {
    const setSpy = captureSet();
    primeWithRow({
      logShippingState: 'failing',
      logShippingFailureStartedAt: new Date('2026-10-12T10:00:00Z'),
      logShippingLastError: 'http 503',
    });
    expect((await beat()).status).toBe(200);
    const s = setCalls(setSpy).find((x) => 'logShippingState' in x);
    expect(s).toMatchObject({
      logShippingState: null,
      logShippingFailureStartedAt: null,
      logShippingLastError: null,
    });
  });

  it.each([
    ['a string', 'garbage'],
    ['wrong schemaVersion', { schemaVersion: 9, queueDepth: 0, droppedLogs: 0 }],
    ['5KB lastError', { schemaVersion: 1, queueDepth: 0, droppedLogs: 0, lastError: 'x'.repeat(5000) }],
  ])('malformed logShipping (%s) on a failing device -> 200, no log-shipping keys', async (_n, bad) => {
    const setSpy = captureSet();
    primeWithRow({
      logShippingState: 'failing',
      logShippingFailureStartedAt: new Date('2026-10-12T10:00:00Z'),
      logShippingLastError: 'http 503',
    });
    expect((await beat({ logShipping: bad })).status).toBe(200);
    expect(lsKeysIn(setSpy)).toEqual([]);
  });
});
