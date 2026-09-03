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

const recordAgentHealthObservationMock = vi.hoisted(() => vi.fn(async (_input: unknown) => ({
  observationId: 'health-observation-1',
  becameLatest: true,
})));

// Default pass-through behaviour for withSystemDbAccessContext — extracted so
// it can be reinstalled via mockImplementationOnce for calls a test doesn't
// care about, while a specific call (targeted by ordering) is made to reject.
// A `vi.fn()` (rather than a bare async function) is required so a test can
// override ONE of the several withSystemDbAccessContext call sites in
// heartbeat.ts (agent-update-policy lookup, policy-probe config, onedrive
// settings, the #2930 shared policy-config block, helper settings) without
// touching the others.
const systemDbAccessContextPassthrough = async (fn: () => Promise<unknown>) => {
  callOrder.push('systemCtx:enter');
  const result = await fn();
  callOrder.push('systemCtx:exit');
  return result;
};
const withSystemDbAccessContextMock = vi.fn(systemDbAccessContextPassthrough);

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) =>
    runOutsideDbContextMock(...(args as [any])),
  // Pass-through that records when the org-scoped context opens and when its
  // callback resolves — in production the org transaction is released at the
  // latter point.
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => {
    callOrder.push('dbContext:opened');
    const result = await fn();
    callOrder.push('dbContext:released');
    return result;
  },
  // Pass-through by default: the effective agent-update-policy lookup (#2123,
  // BEFORE the org block), the policy-probe read, the onedrive settings read,
  // the shared #2930 policy-config block, and the helper-settings read all run
  // in a system context, in that order. Invoke the callback so the mocked
  // resolvers still run, and record enter/exit so tests can assert ordering
  // relative to the org context. A `vi.fn()` so an individual test can swap in
  // a rejection for exactly one call site via mockImplementationOnce.
  withSystemDbAccessContext: (...args: unknown[]) =>
    withSystemDbAccessContextMock(...(args as [() => Promise<unknown>])),
}));

vi.mock('../../db/schema', () => ({
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
  buildMonitoringConfigUpdate: vi.fn(() => undefined),
  buildHelperConfigUpdate: vi.fn(() => undefined),
  buildPamConfigUpdate: vi.fn(async () => ({ uacInterceptionEnabled: false })),
  buildPatchSourceConfigUpdate: vi.fn(async () => ({ exclusiveWindowsUpdate: false })),
  // Null = no onedrive policy for the device. Tests that exercise delivery
  // override this per-test. Omitting it entirely would make every heartbeat
  // test silently exercise only the builder-throws path (undefined is not a
  // function) — which is how the delivery merge went untested pre-#2322-review.
  buildOnedriveHelperConfigUpdate: vi.fn(async () => null),
  // Permissive default (staged + no window = upgrade anytime) and no version
  // pins (issue #2124), so the upgrade gating is transparent to tests that don't
  // care about the org policy. The heartbeat resolves BOTH from this one call.
  getOrgAgentUpdateConfig: vi.fn(async () => ({
    settings: { policy: 'staged', maintenanceWindow: null },
    pins: { agent: null, watchdog: null },
  })),
  // Default target mirrors the `selectMock` '0.66.0' convention used across the
  // upgrade tests: the resolver returns the candidate target version, and the
  // gate + compareAgentVersions (default 0 = no newer) decide whether to send it.
  resolvePinnedUpgradeTarget: vi.fn(async () => '0.66.0'),
  // #4072 — permissive default so the edition gate is transparent to tests
  // that don't exercise it. The edition-gate describe overrides per-test and
  // restores this implementation in afterEach (clearAllMocks does not).
  agentAcceptsServedEdition: vi.fn(() => true),
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

vi.mock('../../middleware/agentAuth', () => ({
  isAgentTokenRotationDue: vi.fn(() => false),
  // #3986 — the ONE definition of the drain claim allowlist. heartbeat.ts reads
  // it as the fail-closed fallback for `agent.claimTypeAllowlist`, so the mock
  // must carry the real value or the fallback would silently mean
  // "unrestricted" in every test.
  DRAIN_CLAIM_TYPE_ALLOWLIST: ['self_uninstall'] as const,
}));

vi.mock('../../services/agentEditionAutoMigrate', () => ({
  maybeDispatchEditionMigration: vi.fn().mockResolvedValue(undefined),
  // Permissive default so the launch-gating tests below control it explicitly.
  shouldConsiderEditionMigration: vi.fn(() => true),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/agentHealthObservations', () => ({
  recordAgentHealthObservation: (...args: unknown[]) =>
    recordAgentHealthObservationMock(...(args as [any])),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn(async () => ({
    helperEnabled: false,
    helperSettings: null,
    manageRemoteManagement: false,
  })),
}));

const getActiveTrustKeysetMock = vi.fn();
const getActiveManifestKeyDelegationsMock = vi.fn();

vi.mock('../../services/manifestSigning', () => ({
  getActiveTrustKeyset: (...args: unknown[]) => {
    callOrder.push('trustKeyset:fetched');
    return getActiveTrustKeysetMock(...(args as []));
  },
  getActiveManifestKeyDelegations: (...args: unknown[]) => {
    callOrder.push('delegations:fetched');
    return getActiveManifestKeyDelegationsMock(...(args as []));
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

import { and, eq, notInArray } from 'drizzle-orm';
import { heartbeatRoutes } from './heartbeat';
import { devices } from '../../db/schema';

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

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      role: 'agent',
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

describe('POST /agents/:id/heartbeat — reachability ownership', () => {
  const pendingDevice = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date('2026-08-01T00:00:00.000Z'),
    status: 'pending',
    lastSeenAt: null,
    mainAgentSilentSince: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    getActiveManifestKeyDelegationsMock.mockResolvedValue([]);
  });

  it('an authenticated main-agent heartbeat promotes pending to online and advances lastSeenAt', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
    selectMock.mockReturnValue(selectChainResolving([]));
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    const response = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(response.status).toBe(200);
    const update = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(update.status).toBe('online');
    expect(update.lastSeenAt).toBeInstanceOf(Date);
  });

  it('records valid v1 health only after the main heartbeat DB context is released', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
    selectMock.mockReturnValue(selectChainResolving([]));
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    callOrder.length = 0;
    recordAgentHealthObservationMock.mockImplementationOnce(async () => {
      callOrder.push('health:persisted');
      return { observationId: 'health-observation-1', becameLatest: true };
    });

    const response = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, healthStatus: healthObservation }),
    });

    expect(response.status).toBe(200);
    expect(recordAgentHealthObservationMock).toHaveBeenCalledWith({
      device: { id: 'device-1', orgId: 'org-1' },
      observation: healthObservation,
      receivedAt: expect.any(Date),
    });
    expect(callOrder.indexOf('dbContext:released')).toBeLessThan(
      callOrder.indexOf('health:persisted'),
    );
  });

  it('does not record a health observation when an old main agent omits it', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
    selectMock.mockReturnValue(selectChainResolving([]));
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    const response = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(response.status).toBe(200);
    expect(recordAgentHealthObservationMock).not.toHaveBeenCalled();
  });

  it('keeps reachability successful and captures a health persistence failure', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
    selectMock.mockReturnValue(selectChainResolving([]));
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    const failure = new Error('health store unavailable');
    recordAgentHealthObservationMock.mockRejectedValueOnce(failure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { captureException } = await import('../../services/sentry');

    const response = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, healthStatus: healthObservation }),
    });

    expect(response.status).toBe(200);
    expect((setSpy.mock.calls as any[])[0]?.[0]).toMatchObject({ status: 'online' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist health observation'),
      failure,
    );
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(failure);
    errorSpy.mockRestore();
  });

  it('drops an explicit mismatched health device identity without calling persistence', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
    selectMock.mockReturnValue(selectChainResolving([]));
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { captureException } = await import('../../services/sentry');

    const response = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        healthStatus: { ...healthObservation, deviceId: 'device-2' },
      }),
    });

    expect(response.status).toBe(200);
    expect(recordAgentHealthObservationMock).not.toHaveBeenCalled();
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('identity mismatch') }),
    );
    errorSpy.mockRestore();
  });

  it('an authenticated watchdog heartbeat updates watchdog fields without changing main reachability', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));
    selectMock.mockReturnValue(selectChainResolving([]));
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });

    const response = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentVersion: '0.65.10',
        role: 'watchdog',
        watchdogState: 'MONITORING',
        healthStatus: healthObservation,
      }),
    });

    expect(response.status).toBe(200);
    const update = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(update).toMatchObject({
      watchdogStatus: 'connected',
      watchdogVersion: '0.65.10',
      watchdogLastSeen: expect.any(Date),
    });
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('lastSeenAt');
    expect(recordAgentHealthObservationMock).not.toHaveBeenCalled();
  });

  it('rejects a missing authenticated agent context without a reachability write', async () => {
    const app = new Hono();
    app.route('/agents', heartbeatRoutes);

    const response = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects a watchdog credential declaring the main-agent role without a reachability write', async () => {
    selectMock.mockReturnValueOnce(selectChainResolving([pendingDevice]));

    const response = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.10', role: 'agent' }),
    });

    expect(response.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /agents/:id/heartbeat — manifestTrustKeys delivery (#639)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getActiveManifestKeyDelegationsMock.mockResolvedValue([]);
    // Module-global watchdog restart-log dedupe cache: without this reset a
    // suite inherits whatever earlier suites logged, so assertions here
    // could pass or fail depending on file execution order.
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();

    // Device lookup → returns a row
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          osVersion: 'Ubuntu 22.04',
          osBuild: null,
          architecture: 'amd64',
          agentVersion: '0.65.10',
          deviceRole: 'server',
          deviceRoleSource: 'auto',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );

    // db.update for devices → no return needed
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => whereResultWithReturning()),
      })),
    });

    // db.insert for deviceMetrics → no return
    insertMock.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    // Any further selects (e.g. agentVersions for upgrade lookup) → empty
    selectMock.mockReturnValue(selectChainResolving([]));
  });

  it('includes manifestTrustKeys from getActiveTrustKeyset() in the 200 response', async () => {
    const trustKeys = [
      {
        keyId: 'deploy-2026-05-14-aaaaaaaa',
        publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        validFrom: '2026-05-14T00:00:00.000Z',
      },
    ];
    getActiveTrustKeysetMock.mockResolvedValue(trustKeys);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestTrustKeys).toEqual(trustKeys);
  });

  it('returns manifestTrustKeys=[] when getActiveTrustKeyset() returns an empty array', async () => {
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestTrustKeys).toEqual([]);
  });

  it('acknowledges a durably ingested rollback observation after the device update commits', async () => {
    const rollbackObservation = {
      schemaVersion: 1,
      observationId: 'a'.repeat(64),
      rollbackId: '10000000-0000-4000-8000-000000000001',
      deviceId: 'device-1',
      phase: 'restart_requested',
      currentVersion: '2.0.0',
      componentVersions: { agent: '1.9.0' },
      observedAt: '2026-08-25T12:00:00Z',
    };
    ingestRollbackObservationMock.mockResolvedValueOnce({
      acknowledgedObservationId: rollbackObservation.observationId,
    });
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, rollbackObservation }),
    });

    expect(resp.status).toBe(200);
    expect(ingestRollbackObservationMock).toHaveBeenCalledWith('device-1', rollbackObservation);
    expect(callOrder.indexOf('dbContext:released')).toBeLessThan(callOrder.lastIndexOf('dbContext:opened'));
    await expect(resp.json()).resolves.toMatchObject({
      acknowledgedRollbackObservationId: rollbackObservation.observationId,
    });
  });

  it('always includes backup_server_url in configUpdate — value when env set', async () => {
    process.env.AGENT_BACKUP_SERVER_URL = 'https://new.example.com';
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown>;
    expect(configUpdate.backup_server_url).toBe('https://new.example.com');
  });

  it('always includes backup_server_url in configUpdate — empty string when env unset (clear signal)', async () => {
    delete process.env.AGENT_BACKUP_SERVER_URL;
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown>;
    expect(configUpdate.backup_server_url).toBe('');
  });

  // Security remediation Wave 6, Task 9 — configUpdate.require_manifest_signing_key_id
  // is ALWAYS sent, as true or false, mirroring AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID.
  // Sending the explicit false is what makes the switch reversible: an agent that
  // already persisted true must revert when the operator reverts the env var, and
  // an omitted key is a no-op on the agent. Agents older than Wave 6 ignore the
  // key whichever way it arrives, so rolling-deploy safety is unaffected.
  it('sends require_manifest_signing_key_id=false in configUpdate when the env var is unset', async () => {
    delete process.env.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID;
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown>;
    expect(configUpdate.require_manifest_signing_key_id).toBe(false);
  });

  it('sends require_manifest_signing_key_id=false in configUpdate when the env var is explicitly false', async () => {
    process.env.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID = 'false';
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown>;
    expect(configUpdate.require_manifest_signing_key_id).toBe(false);
  });

  it('sends require_manifest_signing_key_id=true in configUpdate when the env var is true', async () => {
    process.env.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID = 'true';
    getActiveTrustKeysetMock.mockResolvedValue([]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown>;
    expect(configUpdate.require_manifest_signing_key_id).toBe(true);
  });

  it('#1105: fetches the trust keyset AFTER the org DB context is released (not while holding the tx)', async () => {
    getActiveTrustKeysetMock.mockResolvedValue([]);
    callOrder.length = 0;

    await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    // The whole-request transaction must close before getActiveTrustKeyset
    // runs — otherwise the heartbeat holds its org connection while the trust
    // keyset acquires a SECOND pooled connection, which self-deadlocks the
    // pool under a mass agent reconnect (#1105).
    const released = callOrder.indexOf('dbContext:released');
    const fetched = callOrder.indexOf('trustKeyset:fetched');
    expect(released).toBeGreaterThanOrEqual(0);
    expect(fetched).toBeGreaterThanOrEqual(0);
    expect(released).toBeLessThan(fetched);
  });

  it('omits manifestTrustKeys (still 200) when getActiveTrustKeyset throws', async () => {
    getActiveTrustKeysetMock.mockRejectedValue(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    // Production behavior: on failure manifestTrustKeys defaults to [] in
    // the REST path so agents don't choke parsing the field. The empty
    // array is also what hosted-SaaS returns when no key is provisioned.
    expect(body.manifestTrustKeys).toEqual([]);
  });
});

// =====================================================================
// Wave 6 Task 7 — signed manifest key delegation delivery.
//
// Heartbeat is the path that actually matters for adoption: enrollment
// happens once, but every agent in the fleet heartbeats, so this is how a
// prepared rotation reaches devices that were already enrolled.
// =====================================================================
describe('POST /agents/:id/heartbeat — manifestKeyDelegations delivery (Wave 6 Task 7)', () => {
  const delegation = {
    schemaVersion: 1 as const,
    oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
    newKeyId: 'deploy-2026-08-06-bbbbbbbb',
    newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    epoch: 7,
    notBefore: '2026-08-06T00:00:00Z',
    notAfter: '2026-09-05T00:00:00Z',
    signatureBase64: 'c2ln',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    getActiveManifestKeyDelegationsMock.mockResolvedValue([]);
    // See the note in the #639 suite: the watchdog restart-log cache is
    // module-global, so it must be reset or these assertions inherit
    // dedupe state from whichever suites ran first.
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();

    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          osVersion: 'Ubuntu 22.04',
          osBuild: null,
          architecture: 'amd64',
          agentVersion: '0.65.10',
          deviceRole: 'server',
          deviceRoleSource: 'auto',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => whereResultWithReturning()),
      })),
    });
    insertMock.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });
    selectMock.mockReturnValue(selectChainResolving([]));
  });

  async function heartbeat() {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });
  }

  it('includes manifestKeyDelegations from getActiveManifestKeyDelegations()', async () => {
    getActiveManifestKeyDelegationsMock.mockResolvedValue([delegation]);

    const resp = await heartbeat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestKeyDelegations).toEqual([delegation]);
  });

  it('returns manifestKeyDelegations=[] when nothing is prepared', async () => {
    const resp = await heartbeat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestKeyDelegations).toEqual([]);
  });

  it('still returns 200 with an empty list when the delegation lookup throws', async () => {
    // A rotation-record failure must not take down heartbeat: commands,
    // upgrades and token rotation all ride on this response.
    getActiveManifestKeyDelegationsMock.mockRejectedValue(new Error('boom'));

    const resp = await heartbeat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestKeyDelegations).toEqual([]);
  });

  it('#1105: fetches delegations AFTER the org DB context is released', async () => {
    callOrder.length = 0;
    getActiveManifestKeyDelegationsMock.mockResolvedValue([delegation]);

    await heartbeat();

    const released = callOrder.indexOf('dbContext:released');
    const fetched = callOrder.indexOf('delegations:fetched');
    expect(released).toBeGreaterThanOrEqual(0);
    expect(fetched).toBeGreaterThanOrEqual(0);
    // Same rule as the trust keyset: the org transaction must close before
    // this acquires a second pooled connection, or a mass reconnect
    // self-deadlocks the pool.
    expect(released).toBeLessThan(fetched);
  });

  it('preserves detectWatchdogStateCollapse and the restart-log cache reset export', async () => {
    // Wave 6 Task 7 must not regress the #1121 watchdog surface that other
    // suites in this file depend on.
    const mod = await import('./heartbeat');
    expect(typeof mod.detectWatchdogStateCollapse).toBe('function');
    expect(typeof mod.resetWatchdogRestartLogCacheForTests).toBe('function');
    expect(
      mod.detectWatchdogStateCollapse({ watchdogState: 42 }, undefined),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// #800 — main-agent-silent asymmetry detector
// ---------------------------------------------------------------------
// (buildWatchdogApp is defined above near buildApp.)

describe('POST /agents/:id/heartbeat — main-agent-silent asymmetry detector (#800)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    runOutsideDbContextMock.mockClear();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
  });

  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);

  it('Watchdog heartbeat when main agent silent >15min → sets mainAgentSilentSince + emits event', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'TST-LAPTOP-01',
          osType: 'windows',
          architecture: 'amd64',
          lastSeenAt: sixteenMinutesAgo,
          mainAgentSilentSince: null, // first-transition path
        },
      ]),
    );

    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });

    selectMock.mockReturnValue(selectChainResolving([])); // agentVersions etc

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.15', role: 'watchdog', watchdogState: 'MONITORING' }),
    });

    expect(resp.status).toBe(200);

    // Update called with mainAgentSilentSince set to a Date
    expect(setSpy).toHaveBeenCalled();
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.mainAgentSilentSince).toBeInstanceOf(Date);
    expect(updateArg.watchdogStatus).toBe('connected');

    // Event emitted
    const { publishEvent } = await import('../../services/eventBus');
    expect(publishEvent).toHaveBeenCalledWith(
      'device.main_agent_silent',
      'org-1',
      expect.objectContaining({
        deviceId: 'device-1',
        hostname: 'TST-LAPTOP-01',
        silenceDurationSeconds: expect.any(Number),
      }),
      'heartbeat-watchdog-branch',
      expect.objectContaining({ priority: 'high' }),
    );
  });

  it('Watchdog heartbeat when main agent recently heartbeated → does NOT set mainAgentSilentSince + no event', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          hostname: 'TST-LAPTOP-01',
          lastSeenAt: oneMinuteAgo, // healthy
          mainAgentSilentSince: null,
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    selectMock.mockReturnValue(selectChainResolving([]));

    await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.15', role: 'watchdog', watchdogState: 'MONITORING' }),
    });

    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.mainAgentSilentSince).toBeUndefined();
    const { publishEvent } = await import('../../services/eventBus');
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('Watchdog heartbeat when device already mainAgentSilentSince → does NOT re-emit event (no spam)', async () => {
    // Already-silent state: subsequent watchdog ticks should idempotently
    // update watchdog cols without re-firing the event.
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          hostname: 'host',
          lastSeenAt: sixteenMinutesAgo,
          mainAgentSilentSince: new Date(Date.now() - 10 * 60 * 1000),
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    selectMock.mockReturnValue(selectChainResolving([]));

    await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.15', role: 'watchdog', watchdogState: 'MONITORING' }),
    });

    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    // Already-set timestamp must NOT be overwritten on subsequent ticks
    // (the first-set timestamp tracks "how long has this been going").
    expect(updateArg.mainAgentSilentSince).toBeUndefined();
    const { publishEvent } = await import('../../services/eventBus');
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('Main-agent heartbeat after silence → clears mainAgentSilentSince to NULL', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host',
          osType: 'windows',
          architecture: 'amd64',
          agentVersion: '0.65.15',
          deviceRoleSource: 'auto',
          mainAgentSilentSince: new Date(Date.now() - 5 * 60 * 1000), // currently in silent state
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));

    await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.mainAgentSilentSince).toBeNull();
    expect(updateArg.status).toBe('online');
  });

  it('Main-agent heartbeat with no prior silence → does not touch mainAgentSilentSince', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host',
          osType: 'windows',
          architecture: 'amd64',
          agentVersion: '0.65.15',
          deviceRoleSource: 'auto',
          mainAgentSilentSince: null,
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));

    await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.mainAgentSilentSince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// #799 — watchdog restart-stats logging (Layer B)
// ---------------------------------------------------------------------

// Shared device fixture for watchdog-role heartbeat tests.
const watchdogDeviceRow = {
  id: 'device-1',
  orgId: 'org-1',
  siteId: 'site-1',
  hostname: 'host-1',
  osType: 'linux',
  osVersion: 'Ubuntu 22.04',
  osBuild: null,
  architecture: 'amd64',
  agentVersion: '0.65.20',
  deviceRole: 'server',
  deviceRoleSource: 'auto',
  agentTokenHash: 'hash',
  tokenIssuedAt: new Date(),
  watchdogVersion: '0.65.20',
  watchdogStatus: 'connected',
  watchdogLastSeen: new Date(),
};

// `agent_heartbeat_total` had a Grafana panel and a `NoAgentHeartbeats` alert rule
// but no producer — the route never touched the counter, so both read a flat zero
// against a live fleet. These tests pin the producer in place.
describe('POST /agents/:id/heartbeat — agent_heartbeat_total producer', () => {
  let observed: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    observed = [];
    recordAgentHeartbeatMock.mockImplementation((status: string) => {
      observed.push(status);
    });

    selectMock.mockReturnValueOnce(selectChainResolving([watchdogDeviceRow]));
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockImplementation(() => ({ values: vi.fn(() => Promise.resolve(undefined)) }));
    selectMock.mockReturnValue(selectChainResolving([]));
  });

  it('counts an accepted heartbeat as success', async () => {
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    expect(observed).toEqual(['success']);
  });

  it('counts a rejected heartbeat as failed', async () => {
    // No middleware sets `agent`, so the handler short-circuits with a 401.
    //
    // In production `agentRoutes.use('/:id/*', agentAuthMiddleware)` sits ABOVE
    // this router, so a bad or missing agent token is rejected before reaching
    // the counter — deliberately. `agent_heartbeat_total` answers "are enrolled
    // agents checking in", and counting unauthenticated traffic to a public URL
    // would let anyone on the internet inflate it. `failed` therefore means an
    // authenticated agent whose beat was rejected downstream.
    const app = new Hono();
    app.route('/agents', heartbeatRoutes);

    const resp = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(401);
    expect(observed).toEqual(['failed']);
  });

  it('does not count requests to sibling routes on the same router', async () => {
    const resp = await buildApp().request('/agents/device-1/config');

    expect(resp.status).toBe(200);
    expect(observed).toEqual([]);
  });

  // The middleware is POST-scoped. `use()` would register for every method, and an
  // authenticated GET to this path 404s — which would be counted as a failed
  // heartbeat and drag `NoAgentHeartbeats` toward firing on pure noise.
  it('does not count a non-POST request to the heartbeat path', async () => {
    const resp = await buildApp().request('/agents/device-1/heartbeat');

    expect(resp.status).toBe(404);
    expect(observed).toEqual([]);
  });

  // Pins the docstring claim that the middleware sits OUTSIDE `bodyLimit`, which
  // holds only because the `on('POST', ...)` is registered before the route. An
  // agent that starts sending oversized payloads is exactly what this counter is
  // meant to surface, so the 413 must be counted rather than vanish.
  // (`zValidator` is mocked to a passthrough in this suite, so the schema-rejection
  // half of that claim cannot be exercised here — bodyLimit is the real thing.)
  it('counts an oversized heartbeat rejected by bodyLimit as failed', async () => {
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(5 * 1024 * 1024 + 1),
    });

    expect(resp.status).toBe(413);
    expect(observed).toEqual(['failed']);
  });
});

describe('POST /agents/:id/heartbeat — watchdog restart-stats logging (#799)', () => {
  // Track the values passed to the most recent agentLogs insert.
  let capturedInsertTable: unknown;
  let capturedInsertValues: unknown;

  beforeEach(async () => {
    vi.clearAllMocks();

    // The restart-log dedupe cache is module-global; clear it so each test
    // sees first-occurrence behavior.
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();

    // Device lookup → returns a row with watchdog columns.
    selectMock.mockReturnValueOnce(
      selectChainResolving([watchdogDeviceRow]),
    );

    // db.update for devices (watchdog status update) → no return needed.
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => whereResultWithReturning()),
      })),
    });

    // Intercept db.insert to capture what table and values were provided.
    capturedInsertTable = undefined;
    capturedInsertValues = undefined;
    insertMock.mockImplementation((table: unknown) => {
      capturedInsertTable = table;
      return {
        values: vi.fn((vals: unknown) => {
          capturedInsertValues = vals;
          return Promise.resolve(undefined);
        }),
      };
    });

    // Any further selects (e.g. agentVersions for watchdog upgrade lookup) → empty.
    selectMock.mockReturnValue(selectChainResolving([]));
  });

  it('watchdog heartbeat with mainAgentRestartCount24h=3, flapDetected=false writes a warn-level agent_logs row', async () => {
    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.20',
        watchdogState: 'RECOVERING',
        mainAgentRestartCount24h: 3,
        mainAgentLastRestartAt: '2026-05-22T11:30:00Z',
        flapDetected: false,
      }),
    });

    expect(resp.status).toBe(200);
    // Insert went specifically to agentLogs — assert the table object's sentinel
    // property so a misdirected insert into a different table would be caught.
    expect((capturedInsertTable as { deviceId?: string }).deviceId).toBe('agent_logs.device_id');
    const vals = capturedInsertValues as Record<string, unknown>;
    expect(vals.level).toBe('warn');
    expect(vals.component).toBe('watchdog');
    const fields = vals.fields as Record<string, unknown>;
    expect(fields.count24h).toBe(3);
    expect(fields.flapDetected).toBe(false);
  });

  it('watchdog heartbeat with mainAgentRestartCount24h=5, flapDetected=true writes an error-level agent_logs row', async () => {
    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.20',
        watchdogState: 'FAILOVER',
        mainAgentRestartCount24h: 5,
        mainAgentLastRestartAt: '2026-05-22T10:00:00Z',
        flapDetected: true,
      }),
    });

    expect(resp.status).toBe(200);
    expect((capturedInsertTable as { deviceId?: string }).deviceId).toBe('agent_logs.device_id');
    const vals = capturedInsertValues as Record<string, unknown>;
    expect(vals.level).toBe('error');
    expect(vals.component).toBe('watchdog');
    const fields = vals.fields as Record<string, unknown>;
    expect(fields.count24h).toBe(5);
    expect(fields.flapDetected).toBe(true);
  });

  it('watchdog heartbeat with no restart stats does not write to agent_logs', async () => {
    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.20',
        watchdogState: 'MONITORING',
      }),
    });

    expect(resp.status).toBe(200);
    // insertMock should NOT have been called for agentLogs — no restart activity.
    expect(capturedInsertTable).toBeUndefined();
    expect(capturedInsertValues).toBeUndefined();
  });

  it('suppresses a repeat heartbeat with an identical restart signature (flap-log dedupe)', async () => {
    const body = JSON.stringify({
      role: 'watchdog',
      agentVersion: '0.65.20',
      watchdogState: 'FAILOVER',
      mainAgentRestartCount24h: 5,
      mainAgentLastRestartAt: '2026-05-22T10:00:00Z',
      flapDetected: true,
    });
    const app = buildWatchdogApp();

    const first = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    expect(capturedInsertValues).toBeDefined();

    // Same signature 30s later must not write another row.
    capturedInsertTable = undefined;
    capturedInsertValues = undefined;
    selectMock.mockReturnValueOnce(selectChainResolving([watchdogDeviceRow]));
    const second = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    expect(capturedInsertTable).toBeUndefined();
    expect(capturedInsertValues).toBeUndefined();
  });

  it('a failed insert does not consume the dedupe slot — next heartbeat retries', async () => {
    // First request: the agentLogs insert rejects (transient DB error).
    insertMock.mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.reject(new Error('db down'))),
    }));
    const body = JSON.stringify({
      role: 'watchdog',
      agentVersion: '0.65.20',
      watchdogState: 'FAILOVER',
      mainAgentRestartCount24h: 5,
      mainAgentLastRestartAt: '2026-05-22T10:00:00Z',
      flapDetected: true,
    });
    const app = buildWatchdogApp();
    const first = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200); // insert failure is swallowed
    expect(capturedInsertValues).toBeUndefined();

    // Identical signature 30s later must be retried and land.
    selectMock.mockReturnValueOnce(selectChainResolving([watchdogDeviceRow]));
    const second = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(200);
    expect(capturedInsertValues).toBeDefined();
    expect((capturedInsertValues as Record<string, unknown>).level).toBe('error');
  });

  it('writes again when the restart signature changes', async () => {
    const app = buildWatchdogApp();
    const first = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.20',
        watchdogState: 'RECOVERING',
        mainAgentRestartCount24h: 3,
        mainAgentLastRestartAt: '2026-05-22T10:00:00Z',
        flapDetected: false,
      }),
    });
    expect(first.status).toBe(200);
    expect(capturedInsertValues).toBeDefined();

    capturedInsertTable = undefined;
    capturedInsertValues = undefined;
    selectMock.mockReturnValueOnce(selectChainResolving([watchdogDeviceRow]));
    const second = await app.request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.20',
        watchdogState: 'RECOVERING',
        mainAgentRestartCount24h: 4,
        mainAgentLastRestartAt: '2026-05-22T11:00:00Z',
        flapDetected: false,
      }),
    });
    expect(second.status).toBe(200);
    const vals = capturedInsertValues as Record<string, unknown>;
    expect(vals).toBeDefined();
    expect((vals.fields as Record<string, unknown>).count24h).toBe(4);
  });
});

describe('shouldLogWatchdogRestartActivity (flap-log dedupe unit)', () => {
  beforeEach(async () => {
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();
  });

  it('logs first occurrence, suppresses identical signature within the hour, re-logs after', async () => {
    const {
      shouldLogWatchdogRestartActivity: shouldLog,
      markWatchdogRestartActivityLogged: mark,
    } = await import('./heartbeat');
    const t0 = 1_000_000;
    expect(shouldLog('dev-a', '5|true|x', t0)).toBe(true);
    mark('dev-a', '5|true|x', t0);
    expect(shouldLog('dev-a', '5|true|x', t0 + 30_000)).toBe(false);
    expect(shouldLog('dev-a', '5|true|x', t0 + 59 * 60_000)).toBe(false);
    // Hourly keep-alive: same signature past the interval logs again.
    expect(shouldLog('dev-a', '5|true|x', t0 + 61 * 60_000)).toBe(true);
  });

  it('an unmarked check does not suppress — a failed insert stays retryable', async () => {
    const { shouldLogWatchdogRestartActivity: shouldLog } = await import('./heartbeat');
    const t0 = 1_000_000;
    expect(shouldLog('dev-a', '5|true|x', t0)).toBe(true);
    // No mark (insert failed) → the next heartbeat retries.
    expect(shouldLog('dev-a', '5|true|x', t0 + 30_000)).toBe(true);
  });

  it('a changed signature logs immediately and devices are independent', async () => {
    const {
      shouldLogWatchdogRestartActivity: shouldLog,
      markWatchdogRestartActivityLogged: mark,
    } = await import('./heartbeat');
    const t0 = 1_000_000;
    expect(shouldLog('dev-a', '3|false|x', t0)).toBe(true);
    mark('dev-a', '3|false|x', t0);
    expect(shouldLog('dev-a', '4|false|y', t0 + 1_000)).toBe(true);
    mark('dev-a', '4|false|y', t0 + 1_000);
    // Different device with the same signature is not deduped against dev-a.
    expect(shouldLog('dev-b', '4|false|y', t0 + 2_000)).toBe(true);
    // Suppression re-arms after each write.
    expect(shouldLog('dev-a', '4|false|y', t0 + 3_000)).toBe(false);
  });

  it('bounds the cache: a capacity insert prunes >24h-stale entries', async () => {
    const {
      markWatchdogRestartActivityLogged: mark,
      watchdogRestartLogCacheSizeForTests: cacheSize,
    } = await import('./heartbeat');
    const t0 = 1_000_000;
    for (let i = 0; i < 10_000; i++) mark(`dev-${i}`, 'sig', t0);
    expect(cacheSize()).toBe(10_000);
    mark('dev-new', 'sig', t0 + 25 * 60 * 60_000);
    // Every stale entry pruned; only the new one remains.
    expect(cacheSize()).toBe(1);
  });

  it('bounds the cache when all entries are fresh: evicts oldest-inserted', async () => {
    const {
      shouldLogWatchdogRestartActivity: shouldLog,
      markWatchdogRestartActivityLogged: mark,
      watchdogRestartLogCacheSizeForTests: cacheSize,
    } = await import('./heartbeat');
    const t0 = 1_000_000;
    for (let i = 0; i < 10_000; i++) mark(`dev-${i}`, 'sig', t0);
    mark('dev-new', 'sig', t0 + 60_000);
    expect(cacheSize()).toBe(10_000);
    // dev-0 (oldest-inserted) was evicted → no longer suppressed.
    expect(shouldLog('dev-0', 'sig', t0 + 61_000)).toBe(true);
    expect(shouldLog('dev-new', 'sig', t0 + 61_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// #1104 — watchdog-branch agent recovery: when the watchdog heartbeats
// and the MAIN agent is silent (wedged) AND its recorded version is
// behind latest, the response must carry an agent `upgradeTo` so the
// watchdog's existing failover doUpdateAgent() path can recover it.
// Gated on silence to avoid the watchdog and a healthy main agent both
// updating the same binary.
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — watchdog-branch agent recovery upgradeTo (#1104)', () => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    runOutsideDbContextMock.mockClear();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
  });

  // device lookup (once) then all agentVersions lookups resolve to `latest`.
  function primeSelects(deviceRow: Record<string, unknown>, latest: unknown[]) {
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving(latest));
  }

  async function post() {
    return buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // agentVersion here is the WATCHDOG's own version — not the agent's.
      body: JSON.stringify({ role: 'watchdog', agentVersion: '0.65.20', watchdogState: 'FAILOVER' }),
    });
  }

  it('main agent silent + recorded agentVersion behind → returns agent upgradeTo', async () => {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // latest > recorded
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: '0.65.20',
        lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: null,
      },
      [{ version: '0.66.0' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string };
    expect(body.upgradeTo).toBe('0.66.0');
  });

  it('main agent NOT silent (healthy) → no agent upgradeTo even if version behind', async () => {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: '0.65.20',
        lastSeenAt: oneMinuteAgo, mainAgentSilentSince: null,
      },
      [{ version: '0.66.0' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string };
    expect(body.upgradeTo).toBeUndefined();
  });

  it('main agent silent but already on latest → no agent upgradeTo', async () => {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(0); // up to date
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: '0.66.0', watchdogVersion: '0.65.20',
        lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
      },
      [{ version: '0.66.0' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string };
    expect(body.upgradeTo).toBeUndefined();
  });

  it('main agent silent but no recorded agentVersion → no agent upgradeTo', async () => {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: null, watchdogVersion: '0.65.20',
        lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
      },
      [{ version: '0.66.0' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string };
    expect(body.upgradeTo).toBeUndefined();
  });

  // #2124 — this recovery path is UNGATED by the update policy, so it carries the
  // same `pinsResolved` fail-closed guard as the watchdog bootstrap: if the pin
  // lookup failed we must NOT recover a wedged agent to global latest and thereby
  // defeat a holdback pin on exactly the devices most likely to hit it.
  it('resolver failure (pins unresolved) → withholds agent recovery upgradeTo (fail closed)', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // would upgrade if it got that far
    vi.mocked(getOrgAgentUpdateConfig).mockRejectedValueOnce(new Error('db down'));
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: '0.65.20',
        lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
      },
      [{ version: '0.66.0' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string };
    expect(body.upgradeTo).toBeUndefined();
  });

  // #2124 — the recovery resolve threads the AGENT pin (versionPins.agent), never
  // the watchdog pin. A mis-wiring here would recover the agent to the watchdog's
  // pinned version. Uses component-keyed impl because the watchdog branch resolves
  // first in this same beat; restored at the end so it does not leak.
  it('recovery resolve threads the AGENT pin with this device’s platform/arch (no cross-wiring)', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig, resolvePinnedUpgradeTarget } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValueOnce({
      settings: { policy: 'auto', maintenanceWindow: null },
      pins: { agent: '0.90.0', watchdog: '0.91.0' },
    });
    vi.mocked(resolvePinnedUpgradeTarget).mockImplementation(
      async ({ component }: { component: string }) => (component === 'agent' ? '0.90.0' : '0.91.0'),
    );
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: '0.65.20',
        lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
      },
      [{ version: '0.90.0' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);

    const agentCall = vi.mocked(resolvePinnedUpgradeTarget).mock.calls
      .map((c) => c[0] as any)
      .find((a) => a.component === 'agent');
    expect(agentCall).toMatchObject({ component: 'agent', pin: '0.90.0', platform: 'windows', architecture: 'amd64' });
    expect(agentCall?.pin).not.toBe('0.91.0'); // watchdog pin must not leak in
    const body = await resp.json() as { upgradeTo?: string };
    expect(body.upgradeTo).toBe('0.90.0');

    // Restore the suite's default resolver impl (clearAllMocks does not).
    vi.mocked(resolvePinnedUpgradeTarget).mockResolvedValue('0.66.0');
  });
});


// ---------------------------------------------------------------------
// Controlled fleet rollout — heartbeat is UNCHANGED but must remain correct
// under it. The agent-version upgrade query selects WHERE isLatest=true, so a
// merely-registered-but-un-promoted newer version (isLatest=false) is invisible
// to heartbeat and yields NO upgradeTo. Only the explicitly-promoted version
// (isLatest=true) is offered. These tests pin that contract.
// ---------------------------------------------------------------------
describe('POST /agents/:id/heartbeat — controlled fleet rollout (promotion gates upgradeTo)', () => {
  const agentDeviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'windows',
    osVersion: 'Windows 11',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.70.0',
    deviceRole: 'workstation',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  // device lookup (once), then the agentVersions upgrade lookups resolve to
  // `promotedRows`. An empty array models "no isLatest=true row" — i.e. the
  // newer version exists in the table but was never promoted.
  function prime(promotedRows: unknown[]) {
    selectMock.mockReturnValueOnce(selectChainResolving([agentDeviceRow]));
    selectMock.mockReturnValue(selectChainResolving(promotedRows));
  }

  async function beat() {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, agentVersion: '0.70.0' }),
    });
  }

  it('offers upgradeTo for the explicitly-promoted (isLatest=true) version', async () => {
    const { compareAgentVersions, resolvePinnedUpgradeTarget } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // promoted > reported
    // The resolver returns the promoted version as the candidate target (its
    // isLatest-query behaviour is unit-tested in helpers.agentUpdatePolicy.test).
    vi.mocked(resolvePinnedUpgradeTarget).mockResolvedValueOnce('0.71.0');
    prime([{ version: '0.71.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBe('0.71.0');
  });

  it('does NOT offer upgradeTo when the newer version is merely registered but un-promoted (no isLatest=true row)', async () => {
    const { compareAgentVersions, resolvePinnedUpgradeTarget } = await import('./helpers');
    // Even if a comparison WOULD say newer, the resolver returns null (no
    // isLatest=true row and no pin), so the handler never reaches a target.
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(resolvePinnedUpgradeTarget).mockResolvedValueOnce(null);
    prime([]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// #4072 — artifact-edition offer gate. An agent build that would refuse the
// served artifact edition (updater-side check, post-download) must not be
// OFFERED the version at all: the refusal loop retries every ~60s forever
// with the device stuck in 'updating'. These tests pin the wiring — every
// offer path consults agentAcceptsServedEdition with THIS beat's payload
// values and withholds on false. The predicate's own logic is unit-tested in
// helpers.agentUpdatePolicy.test.ts.
// ---------------------------------------------------------------------
describe('POST /agents/:id/heartbeat — artifact-edition offer gate (#4072)', () => {
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
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    const { agentAcceptsServedEdition, compareAgentVersions } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => true);
    vi.mocked(compareAgentVersions).mockReturnValue(1); // target > reported everywhere
  });

  afterEach(async () => {
    // Restore the permissive default for the rest of the file — clearAllMocks
    // clears calls, not implementations, so a leaked `false` would silently
    // withhold offers in every later upgrade test.
    const { agentAcceptsServedEdition, compareAgentVersions } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => true);
    vi.mocked(compareAgentVersions).mockReturnValue(0);
  });

  function prime(versionRows: unknown[]) {
    selectMock.mockReturnValueOnce(selectChainResolving([agentDeviceRow]));
    selectMock.mockReturnValue(selectChainResolving(versionRows));
  }

  async function beat(extra: Record<string, unknown> = {}) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, agentVersion: '0.105.1', ...extra }),
    });
  }

  type OfferBody = { upgradeTo?: string; helperUpgradeTo?: string; watchdogUpgradeTo?: string };

  it('withholds the agent upgrade offer when the build cannot accept the served edition', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    prime([{ version: '0.66.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    // Main-branch "no offer" serializes as null (matching the un-promoted
    // rollout contract above), which agents treat the same as absent.
    const body = (await resp.json()) as OfferBody;
    expect(body.upgradeTo).toBeFalsy();
  });

  it('withholds the helper offer — including the ungated bootstrap install (no helperVersion reported)', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    prime([{ version: '0.66.0' }]);

    const resp = await beat(); // no helperVersion → would bootstrap-offer latest
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as OfferBody;
    expect(body.helperUpgradeTo).toBeUndefined();
  });

  it('withholds the watchdog offer — including the ungated bootstrap install', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    prime([{ version: '0.66.0' }]); // watchdogVersion absent on row + beat → bootstrap path

    const resp = await beat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as OfferBody;
    expect(body.watchdogUpgradeTo).toBeUndefined();
  });

  it('hands the withheld device to the auto edition migration hook (fire-and-forget)', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    const { maybeDispatchEditionMigration } = await import('../../services/agentEditionAutoMigrate');
    prime([{ version: '0.66.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    expect(vi.mocked(maybeDispatchEditionMigration)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(maybeDispatchEditionMigration).mock.calls[0]![0];
    expect(args.device.id).toBe('device-1');
    expect(args.reportedAgentVersion).toBe('0.105.1');
    expect(args.normalizedArch).toBe('amd64');
    expect(typeof args.updateGateAllows).toBe('boolean');
    expect(typeof args.resolveTarget).toBe('function');
  });

  it('does NOT launch the dispatch when the cheap precheck says no (flag off / non-candidate)', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    const { maybeDispatchEditionMigration, shouldConsiderEditionMigration } = await import(
      '../../services/agentEditionAutoMigrate'
    );
    // Once-only: clearAllMocks clears calls, not implementations, so a
    // persistent false here would leak into every later hook test.
    vi.mocked(shouldConsiderEditionMigration).mockReturnValueOnce(false);
    prime([{ version: '0.66.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    expect(vi.mocked(maybeDispatchEditionMigration)).not.toHaveBeenCalled();
  });

  it('does NOT invoke the auto edition migration hook when the build accepts the served edition', async () => {
    const { maybeDispatchEditionMigration } = await import('../../services/agentEditionAutoMigrate');
    prime([{ version: '0.66.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    expect(vi.mocked(maybeDispatchEditionMigration)).not.toHaveBeenCalled();
  });

  it('a rejected auto-migration promise never fails the heartbeat', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    const { maybeDispatchEditionMigration } = await import('../../services/agentEditionAutoMigrate');
    vi.mocked(maybeDispatchEditionMigration).mockRejectedValueOnce(new Error('dispatch exploded'));
    prime([{ version: '0.66.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
  });

  it('offers normally when the build accepts the served edition (gate true)', async () => {
    prime([{ version: '0.66.0' }]);

    const resp = await beat();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as OfferBody;
    expect(body.upgradeTo).toBe('0.66.0');
  });

  it('consults the gate with THIS beat’s payload values (reported edition + version), not stored columns', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    prime([{ version: '0.66.0' }]);

    const resp = await beat({ agentEdition: 'self-host' });
    expect(resp.status).toBe(200);
    expect(vi.mocked(agentAcceptsServedEdition)).toHaveBeenCalledWith({
      reportedEdition: 'self-host',
      agentVersion: '0.105.1',
    });
  });

  it('logs the withhold once per device per process, not per heartbeat', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    const { __resetEditionWithheldWarnCacheForTests } = await import('./heartbeat');
    __resetEditionWithheldWarnCacheForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      prime([{ version: '0.66.0' }]);
      await beat();
      prime([{ version: '0.66.0' }]);
      await beat();
      const withheldWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('#4072'));
      expect(withheldWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('routes the withhold to Sentry once per process (fleet-freeze observability parity with the pin-miss path)', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    const { captureException } = await import('../../services/sentry');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    const { __resetEditionWithheldWarnCacheForTests } = await import('./heartbeat');
    __resetEditionWithheldWarnCacheForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      prime([{ version: '0.66.0' }]);
      await beat();
      prime([{ version: '0.66.0' }]);
      await beat();
      const withheldCaptures = vi
        .mocked(captureException)
        .mock.calls.filter((c) => String((c[0] as Error)?.message ?? c[0]).includes('#4072'));
      expect(withheldCaptures).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('re-arms the per-device warn once the device accepts again (a later regression must re-log)', async () => {
    const { agentAcceptsServedEdition } = await import('./helpers');
    vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
    const { __resetEditionWithheldWarnCacheForTests } = await import('./heartbeat');
    __resetEditionWithheldWarnCacheForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      prime([{ version: '0.66.0' }]);
      await beat(); // withheld → warns
      vi.mocked(agentAcceptsServedEdition).mockImplementation(() => true);
      prime([{ version: '0.66.0' }]);
      await beat(); // accepting → clears the dedupe entry
      vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
      prime([{ version: '0.66.0' }]);
      await beat(); // regressed → must warn AGAIN
      const withheldWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('#4072'));
      expect(withheldWarns).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('watchdog failover branch', () => {
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);

    function primeWatchdog() {
      selectMock.mockReturnValueOnce(
        selectChainResolving([
          {
            id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
            architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: '0.65.20',
            lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
          },
        ]),
      );
      selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    }

    async function watchdogBeat() {
      return buildWatchdogApp().request('/agents/device-1/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role: 'watchdog', agentVersion: '0.65.20', agentEdition: 'hosted', watchdogState: 'FAILOVER',
        }),
      });
    }

    it('withholds BOTH the watchdog self-update and the agent recovery offer when the watchdog build cannot accept the served edition', async () => {
      const { agentAcceptsServedEdition } = await import('./helpers');
      vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
      primeWatchdog();

      const resp = await watchdogBeat();
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as OfferBody;
      expect(body.watchdogUpgradeTo).toBeUndefined();
      expect(body.upgradeTo).toBeUndefined();
    });

    it('consults the gate with the WATCHDOG’s own payload (it is the binary that downloads in failover)', async () => {
      const { agentAcceptsServedEdition } = await import('./helpers');
      primeWatchdog();

      const resp = await watchdogBeat();
      expect(resp.status).toBe(200);
      expect(vi.mocked(agentAcceptsServedEdition)).toHaveBeenCalledWith({
        reportedEdition: 'hosted',
        agentVersion: '0.65.20',
      });
      const body = (await resp.json()) as OfferBody;
      expect(body.watchdogUpgradeTo).toBe('0.66.0');
      expect(body.upgradeTo).toBe('0.66.0');
    });

    it('a SILENT watchdog falls back to the device row’s stored agentEdition — deployed watchdogs predate edition reporting, and withholding recovery from the whole hosted fleet would be the regression', async () => {
      const { agentAcceptsServedEdition } = await import('./helpers');
      selectMock.mockReturnValueOnce(
        selectChainResolving([
          {
            id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
            architecture: 'amd64', agentVersion: '0.107.1', watchdogVersion: '0.107.1',
            agentEdition: 'hosted',
            lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
          },
        ]),
      );
      selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

      // Watchdog beat WITHOUT agentEdition — every watchdog in the field today.
      const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'watchdog', agentVersion: '0.107.1', watchdogState: 'FAILOVER' }),
      });
      expect(resp.status).toBe(200);
      expect(vi.mocked(agentAcceptsServedEdition)).toHaveBeenCalledWith({
        reportedEdition: 'hosted',
        agentVersion: '0.107.1',
      });
    });

    it('a withheld RECOVERY (main agent silent) logs at error level and captures to Sentry — a device stuck offline must never be silent', async () => {
      const { agentAcceptsServedEdition } = await import('./helpers');
      const { captureException } = await import('../../services/sentry');
      vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
      const { __resetEditionWithheldWarnCacheForTests } = await import('./heartbeat');
      __resetEditionWithheldWarnCacheForTests();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        primeWatchdog();
        await watchdogBeat();
        primeWatchdog();
        await watchdogBeat();
        const recoveryErrors = errorSpy.mock.calls.filter(
          (c) => String(c[0]).includes('#4072') && String(c[0]).toLowerCase().includes('recovery'),
        );
        // Deduped per device per process — once, not per failover beat.
        expect(recoveryErrors).toHaveLength(1);
        const recoveryCaptures = vi
          .mocked(captureException)
          .mock.calls.filter((c) => String((c[0] as Error)?.message ?? c[0]).includes('recovery withheld'));
        expect(recoveryCaptures).toHaveLength(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('a MAIN-agent beat re-arms the recovery error — a second wedge weeks later must alert again', async () => {
      const { agentAcceptsServedEdition } = await import('./helpers');
      vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
      const { __resetEditionWithheldWarnCacheForTests } = await import('./heartbeat');
      __resetEditionWithheldWarnCacheForTests();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        primeWatchdog();
        await watchdogBeat(); // wedge #1 → recovery error
        // Main agent comes back and beats (proof of recovery) — clears the entry.
        prime([{ version: '0.66.0' }]);
        await beat();
        primeWatchdog();
        await watchdogBeat(); // wedge #2 → must error AGAIN
        const recoveryErrors = errorSpy.mock.calls.filter(
          (c) => String(c[0]).includes('#4072') && String(c[0]).toLowerCase().includes('recovery'),
        );
        expect(recoveryErrors).toHaveLength(2);
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('a silent watchdog whose withhold came from the STORED edition reports that stored value in the log, not "none"', async () => {
      const { agentAcceptsServedEdition } = await import('./helpers');
      vi.mocked(agentAcceptsServedEdition).mockImplementation(() => false);
      const { __resetEditionWithheldWarnCacheForTests } = await import('./heartbeat');
      __resetEditionWithheldWarnCacheForTests();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        selectMock.mockReturnValueOnce(
          selectChainResolving([
            {
              id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
              architecture: 'amd64', agentVersion: '0.107.1', watchdogVersion: '0.107.1',
              agentEdition: 'hosted',
              lastSeenAt: sixteenMinutesAgo, mainAgentSilentSince: new Date(),
            },
          ]),
        );
        selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
        const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'watchdog', agentVersion: '0.107.1', watchdogState: 'FAILOVER' }),
        });
        expect(resp.status).toBe(200);
        const recoveryErrors = errorSpy.mock.calls.filter((c) => String(c[0]).includes('#4072'));
        expect(recoveryErrors.length).toBeGreaterThan(0);
        // The decision used the stored 'hosted' fallback — the log must print
        // the value that decided, not the silent payload.
        expect(String(recoveryErrors[0]?.[0])).toContain('reported edition=hosted');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describe('detectWatchdogStateCollapse (#1121)', () => {
  it('reports a collapse when raw body carried watchdogState but validation dropped it', async () => {
    const { detectWatchdogStateCollapse } = await import('./heartbeat');
    expect(
      detectWatchdogStateCollapse({ agentVersion: '1', watchdogState: 42 }, undefined),
    ).toEqual({ field: 'watchdogState', rawValue: '42' });
    expect(
      detectWatchdogStateCollapse({ watchdogState: { nested: true } }, undefined),
    ).toEqual({ field: 'watchdogState', rawValue: '{"nested":true}' });
  });

  it('truncates oversized raw values to 100 chars', async () => {
    const { detectWatchdogStateCollapse } = await import('./heartbeat');
    const big = 'x'.repeat(5000);
    // An oversized STRING would actually pass z.string(); simulate a
    // corrupted huge non-string payload via an array of strings.
    const res = detectWatchdogStateCollapse({ watchdogState: [big] }, undefined);
    expect(res).not.toBeNull();
    expect(res!.rawValue!.length).toBeLessThanOrEqual(100);
  });

  it('returns null when validation kept a value (no collapse)', async () => {
    const { detectWatchdogStateCollapse } = await import('./heartbeat');
    expect(
      detectWatchdogStateCollapse({ watchdogState: 'FAILOVER' }, 'FAILOVER'),
    ).toBeNull();
  });

  it('returns null when the raw body never had the key (normal main-agent heartbeat)', async () => {
    const { detectWatchdogStateCollapse } = await import('./heartbeat');
    expect(detectWatchdogStateCollapse({ agentVersion: '1' }, undefined)).toBeNull();
    expect(detectWatchdogStateCollapse(null, undefined)).toBeNull();
    expect(detectWatchdogStateCollapse('not-an-object', undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// pendingReboot persistence
// ---------------------------------------------------------------------

describe('pendingReboot persistence', () => {
  // Device row used across all three tests — minimal fields the handler needs.
  const deviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    mainAgentSilentSince: null,
  };

  function setupMocks(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
  }

  it('persists pendingReboot=true from the main-agent heartbeat', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, pendingReboot: true }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.pendingReboot).toBe(true);
  });

  it('clears pendingReboot when the field is absent (old agents / post-reboot)', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy);

    // minimalHeartbeatBody has no pendingReboot key — simulates old agents and
    // post-reboot heartbeats where the flag was true before the reboot.
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.pendingReboot).toBe(false);
  });

  it('watchdog heartbeats never touch pendingReboot', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    // Watchdog device lookup needs lastSeenAt for the silence-detector.
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(
      selectChainResolving([{ ...deviceRow, lastSeenAt: new Date() }]),
    );
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Include pendingReboot in the payload to prove it is ignored by the
      // watchdog branch.
      body: JSON.stringify({ role: 'watchdog', agentVersion: '0.65.10', watchdogState: 'MONITORING', pendingReboot: true }),
    });

    expect(resp.status).toBe(200);
    expect(setSpy).toHaveBeenCalled();
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    // Guard that we captured the watchdog update (not a trivially-undefined
    // arg) before asserting the flag is absent from it.
    expect(updateArg).toHaveProperty('watchdogStatus');
    expect(updateArg).not.toHaveProperty('pendingReboot');
  });
});

// ---------------------------------------------------------------------
// outboundNetworkPolicyVersion capability handshake (Wave 6 Task 4, security
// remediation)
// ---------------------------------------------------------------------
describe('outboundNetworkPolicyVersion capability handshake (Wave 6)', () => {
  const deviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    mainAgentSilentSince: null,
  };

  async function setupMocks(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    // Dedupe cache is a module-global — reset it so a capability assertion in
    // one test can never inherit state left behind by another.
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
  }

  it('records version 1 from a capable heartbeat', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { outboundNetworkPolicyVersion: 1 },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.outboundNetworkPolicyVersion).toBe(1);
  });

  it('leaves version 0 when an old heartbeat omits securityCapabilities entirely', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    // minimalHeartbeatBody has no securityCapabilities key — simulates an
    // agent build that predates Wave 6 Task 4.
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.outboundNetworkPolicyVersion).toBe(0);
  });

  it('records version 0 for an unrecognized capability version rather than trusting it', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { outboundNetworkPolicyVersion: 2 },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.outboundNetworkPolicyVersion).toBe(0);
  });

  it('resets a previously-capable device back to 0 on a downgraded (old) heartbeat', async () => {
    // Same device row shape regardless of its PRIOR stored capability value —
    // the write is unconditional every heartbeat, not a merge against the
    // existing row, so what matters is what THIS heartbeat declares.
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.outboundNetworkPolicyVersion).toBe(0);
  });

  it('watchdog heartbeats never touch outboundNetworkPolicyVersion', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    vi.clearAllMocks();
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(
      selectChainResolving([{ ...deviceRow, lastSeenAt: new Date() }]),
    );
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.10',
        watchdogState: 'MONITORING',
        securityCapabilities: { outboundNetworkPolicyVersion: 1 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(setSpy).toHaveBeenCalled();
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toHaveProperty('watchdogStatus');
    expect(updateArg).not.toHaveProperty('outboundNetworkPolicyVersion');
  });

  // ---------------------------------------------------------------------
  // #3409 PR4a — scriptSecretEnvVersion capability handshake. Same contract as
  // outboundNetworkPolicyVersion above (explicit version, non-sticky) because
  // an agent that ignores `secretEnv` runs the script with the credential env
  // var UNSET — anonymous access, auth fallback, or a destructive operation
  // against the wrong target. PR4c gates dispatch on this value.
  // ---------------------------------------------------------------------
  it('records scriptSecretEnvVersion 1 from a capable heartbeat', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { scriptSecretEnvVersion: 1 },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.scriptSecretEnvVersion).toBe(1);
  });

  it('records scriptSecretEnvVersion 0 when the heartbeat omits it (old build)', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.scriptSecretEnvVersion).toBe(0);
  });

  it('reports scriptSecretEnvVersion back down to 0 on a downgrade (non-sticky)', async () => {
    // The write is unconditional every heartbeat, so a build that stops
    // declaring the capability cannot leave a stale claim the PR4c dispatch
    // gate would wrongly trust.
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, securityCapabilities: {} }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.scriptSecretEnvVersion).toBe(0);
  });

  it('records scriptSecretEnvVersion 0 for an unrecognized version rather than trusting it', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { scriptSecretEnvVersion: 99 },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.scriptSecretEnvVersion).toBe(0);
  });

  it('a malformed capability value does not 400 the whole heartbeat', async () => {
    // Informational field: a bad value drops the object (.catch) rather than
    // rejecting a heartbeat the fleet depends on.
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { scriptSecretEnvVersion: 'yes' },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.scriptSecretEnvVersion).toBe(0);
  });

  it('drops malformed PAM reconciliation telemetry without dropping capability versions', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: {
          peripheralPolicyProtocolVersion: 2,
          pamLifetimeProtocolVersion: 2,
          pamReconciliation: {
            unresolvedCount: -1,
            quarantinedCount: 0,
            awaitingAcknowledgementCount: 0,
          },
        },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.peripheralPolicyProtocolVersion).toBe(2);
    expect(updateArg.pamLifetimeProtocolVersion).toBe(2);
  });

  it.each([
    {
      name: 'recognized exact integers',
      capabilities: { peripheralPolicyProtocolVersion: 2, rollbackProtocolVersion: 1, pamLifetimeProtocolVersion: 2 },
      expectedPeripheral: 2,
      expectedRollback: 1,
      expectedPam: 2,
    },
    {
      name: 'omitted capability object',
      capabilities: undefined,
      expectedPeripheral: 0,
      expectedRollback: 0,
      expectedPam: 0,
    },
    {
      name: 'explicit zero downgrade',
      capabilities: { peripheralPolicyProtocolVersion: 0, rollbackProtocolVersion: 0, pamLifetimeProtocolVersion: 0 },
      expectedPeripheral: 0,
      expectedRollback: 0,
      expectedPam: 0,
    },
    {
      name: 'unknown integer versions',
      capabilities: { peripheralPolicyProtocolVersion: 3, rollbackProtocolVersion: 2, pamLifetimeProtocolVersion: 3 },
      expectedPeripheral: 0,
      expectedRollback: 0,
      expectedPam: 0,
    },
    {
      name: 'fractional versions',
      capabilities: { peripheralPolicyProtocolVersion: 2.5, rollbackProtocolVersion: 1.5, pamLifetimeProtocolVersion: 2.5 },
      expectedPeripheral: 0,
      expectedRollback: 0,
      expectedPam: 0,
    },
    {
      name: 'string versions',
      capabilities: { peripheralPolicyProtocolVersion: '2', rollbackProtocolVersion: '1', pamLifetimeProtocolVersion: '2' },
      expectedPeripheral: 0,
      expectedRollback: 0,
      expectedPam: 0,
    },
  ])('persists tolerant non-sticky control protocol capabilities: $name', async ({
    capabilities,
    expectedPeripheral,
    expectedRollback,
    expectedPam,
  }) => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const body = capabilities === undefined
      ? minimalHeartbeatBody
      : { ...minimalHeartbeatBody, securityCapabilities: capabilities };
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.peripheralPolicyProtocolVersion).toBe(expectedPeripheral);
    expect(updateArg.rollbackProtocolVersion).toBe(expectedRollback);
    expect(updateArg.pamLifetimeProtocolVersion).toBe(expectedPam);
  });
});

// ---------------------------------------------------------------------
// agentEdition / migrationRequired persistence (self-healing, migration
// banner Task 2). Modeled on the outboundNetworkPolicyVersion capability
// handshake above: both fields are written UNCONDITIONALLY every beat, so an
// omitted field resets to its default rather than leaving a stale value.
// ---------------------------------------------------------------------
describe('agentEdition / migrationRequired persistence (self-healing)', () => {
  const deviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    mainAgentSilentSince: null,
  };

  async function setupMocks(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
  }

  it('persists agentEdition + migrationRequired from the heartbeat', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        agentEdition: 'hosted',
        migrationRequired: true,
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.agentEdition).toBe('hosted');
    expect(updateArg.migrationRequired).toBe(true);
  });

  it('self-heals to null/false when a later heartbeat omits the fields', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    // minimalHeartbeatBody carries neither key — simulates an agent that
    // previously reported agentEdition/migrationRequired but no longer does
    // (or an old agent that never did). The write must be unconditional so
    // this beat clears any stale value rather than leaving it sticky.
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.agentEdition).toBeNull();
    expect(updateArg.migrationRequired).toBe(false);
  });

  it('watchdog heartbeats never touch agentEdition/migrationRequired', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    vi.clearAllMocks();
    const { resetWatchdogRestartLogCacheForTests } = await import('./heartbeat');
    resetWatchdogRestartLogCacheForTests();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(
      selectChainResolving([{ ...deviceRow, lastSeenAt: new Date() }]),
    );
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'watchdog',
        agentVersion: '0.65.10',
        watchdogState: 'MONITORING',
        agentEdition: 'hosted',
        migrationRequired: true,
      }),
    });

    expect(resp.status).toBe(200);
    expect(setSpy).toHaveBeenCalled();
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toHaveProperty('watchdogStatus');
    expect(updateArg).not.toHaveProperty('agentEdition');
    expect(updateArg).not.toHaveProperty('migrationRequired');
  });
});

// ---------------------------------------------------------------------
// batteryStatus persistence (#2142)
// ---------------------------------------------------------------------

describe('batteryStatus persistence', () => {
  const deviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    mainAgentSilentSince: null,
  };

  function setupMocks(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
  }

  it('persists a battery snapshot, stamping reportedAt and keeping only sent fields', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        battery: { present: true, percent: 85, chargingState: 'discharging', pluggedIn: false, timeRemainingMinutes: 150 },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    const battery = updateArg.batteryStatus as Record<string, unknown>;
    expect(battery).toMatchObject({
      present: true,
      percent: 85,
      chargingState: 'discharging',
      pluggedIn: false,
      timeRemainingMinutes: 150,
    });
    // reportedAt is stamped server-side; timeToFull was never sent so it is absent.
    expect(typeof battery.reportedAt).toBe('string');
    expect(battery).not.toHaveProperty('timeToFullMinutes');
  });

  it('persists a charging snapshot with timeToFullMinutes', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        battery: { present: true, percent: 60, chargingState: 'charging', pluggedIn: true, timeToFullMinutes: 45 },
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    const battery = updateArg.batteryStatus as Record<string, unknown>;
    expect(battery).toMatchObject({ present: true, chargingState: 'charging', pluggedIn: true, timeToFullMinutes: 45 });
    expect(battery).not.toHaveProperty('timeRemainingMinutes');
  });

  it('records a no-battery desktop as { present: false }', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, battery: { present: false, pluggedIn: true } }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    const battery = updateArg.batteryStatus as Record<string, unknown>;
    expect(battery.present).toBe(false);
    expect(battery.pluggedIn).toBe(true);
    expect(battery).not.toHaveProperty('percent');
  });

  it('leaves batteryStatus untouched when the agent omits battery (old agent)', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('batteryStatus');
  });
});

// ---------------------------------------------------------------------
// uninstallIntentAt clearing (#2764 — Task 5)
// ---------------------------------------------------------------------

describe('uninstallIntentAt clearing (#2764)', () => {
  const deviceRowWithIntent = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    mainAgentSilentSince: null,
    uninstallIntentAt: new Date('2026-08-01T00:00:00Z'),
  };

  function setupMocks(setSpy: ReturnType<typeof vi.fn>, deviceRow: Record<string, unknown>) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
  }

  it('clears a previously-set uninstallIntentAt unconditionally', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy, deviceRowWithIntent);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toHaveProperty('uninstallIntentAt', null);
  });

  it('writes uninstallIntentAt: null even when the row had no intent set (steady-state beat)', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    setupMocks(setSpy, { ...deviceRowWithIntent, uninstallIntentAt: null });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toHaveProperty('uninstallIntentAt', null);
  });
});

// ---------------------------------------------------------------------
// PAM config delivery (#uacInterceptionEnabled in heartbeat response)
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — uacInterceptionEnabled delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Device lookup → returns a row
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'windows',
          osVersion: 'Windows 11',
          osBuild: null,
          architecture: 'amd64',
          agentVersion: '0.70.0',
          deviceRole: 'workstation',
          deviceRoleSource: 'auto',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );

    // db.update for devices → no return needed
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => whereResultWithReturning()),
      })),
    });

    // db.insert for deviceMetrics → no return
    insertMock.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    // Any further selects → empty
    selectMock.mockReturnValue(selectChainResolving([]));

    getActiveTrustKeysetMock.mockResolvedValue([]);
  });

  it('delivers uacInterceptionEnabled: false when buildPamConfigUpdate returns false', async () => {
    // buildPamConfigUpdate mock returns { uacInterceptionEnabled: false } from vi.mock factory above
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.uacInterceptionEnabled).toBe(false);
  });

  it('fails closed to uacInterceptionEnabled=false when the pam resolver throws (opt-in)', async () => {
    const { buildPamConfigUpdate } = await import('./helpers');
    vi.mocked(buildPamConfigUpdate).mockRejectedValueOnce(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.uacInterceptionEnabled).toBe(false);
  });

  it('includes patch_source_settings in configUpdate when enforcement is enabled (#1872)', async () => {
    const { buildPatchSourceConfigUpdate } = await import('./helpers');
    vi.mocked(buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
  });

  it('omits patch_source_settings when the patch resolver throws (no unintended revert)', async () => {
    const { buildPatchSourceConfigUpdate } = await import('./helpers');
    vi.mocked(buildPatchSourceConfigUpdate).mockRejectedValueOnce(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.patch_source_settings).toBeUndefined();
  });

  it('delivers onedrive_helper_settings in configUpdate alongside other config (post-#1105 hoist merge)', async () => {
    const { buildOnedriveHelperConfigUpdate, buildPatchSourceConfigUpdate } = await import('./helpers');
    const settings = {
      base: {
        silentAccountConfig: true, filesOnDemand: true, kfmSilentOptIn: false,
        kfmFolders: [], kfmBlockOptOut: false, tenantAssociationId: null, restartOnChange: true,
      },
      libraries: [{
        libraryId: 'lib-1', displayName: 'Docs', siteUrl: null, targetingMode: 'graph_group',
        groupId: 'g-1', groupName: null, hiveScope: 'hkcu', allowedUpns: ['u@contoso.com'],
      }],
    };
    vi.mocked(buildOnedriveHelperConfigUpdate).mockResolvedValueOnce(settings as any);
    vi.mocked(buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    // The exact wire key the agent reads — a rename here darkens the feature fleet-wide.
    expect(configUpdate?.onedrive_helper_settings).toEqual(settings);
    // And the three-way spread must compose, not replace, the other config.
    expect(configUpdate?.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
  });

  it('omits onedrive_helper_settings when the builder throws — heartbeat still 200 with other config intact', async () => {
    const { buildOnedriveHelperConfigUpdate, buildPatchSourceConfigUpdate } = await import('./helpers');
    vi.mocked(buildOnedriveHelperConfigUpdate).mockRejectedValueOnce(new Error('graph down'));
    vi.mocked(buildPatchSourceConfigUpdate).mockResolvedValueOnce({ exclusiveWindowsUpdate: true });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.onedrive_helper_settings).toBeUndefined();
    expect(configUpdate?.patch_source_settings).toEqual({ exclusiveWindowsUpdate: true });
  });

  // #2930 coverage gap — event_log_settings and monitoring_settings were only
  // ever exercised via their vi.fn(() => undefined) defaults; the delivery and
  // resolver-throws paths were untested even though patch_source_settings
  // (the sibling resolver in the same shared policy-config block) had both.
  it('includes event_log_settings in configUpdate when the resolver succeeds', async () => {
    const { buildEventLogConfigUpdate } = await import('./helpers');
    const settings = {
      max_events_per_cycle: 250,
      collect_categories: ['security', 'system'],
      minimum_level: 'warning',
      collection_interval_minutes: 15,
    };
    vi.mocked(buildEventLogConfigUpdate).mockResolvedValueOnce(settings);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.event_log_settings).toEqual(settings);
  });

  it('omits event_log_settings when the resolver throws (no unintended revert)', async () => {
    const { buildEventLogConfigUpdate } = await import('./helpers');
    vi.mocked(buildEventLogConfigUpdate).mockRejectedValueOnce(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.event_log_settings).toBeUndefined();
  });

  it('includes monitoring_settings in configUpdate when the resolver succeeds', async () => {
    const { buildMonitoringConfigUpdate } = await import('./helpers');
    const settings = {
      check_interval_seconds: 60,
      watches: [
        {
          watch_type: 'process',
          name: 'agent-watch',
          alert_on_stop: true,
          alert_after_consecutive_failures: 2,
          auto_restart: true,
          max_restart_attempts: 3,
          restart_cooldown_seconds: 30,
        },
      ],
    };
    vi.mocked(buildMonitoringConfigUpdate).mockResolvedValueOnce(settings as any);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.monitoring_settings).toEqual(settings);
  });

  it('omits monitoring_settings when the resolver throws (no unintended revert)', async () => {
    const { buildMonitoringConfigUpdate } = await import('./helpers');
    vi.mocked(buildMonitoringConfigUpdate).mockRejectedValueOnce(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.monitoring_settings).toBeUndefined();
  });

  // Existing coverage only exercised the `false` default and the
  // resolver-throws fail-closed path; the successful opt-in delivery was
  // never asserted.
  it('delivers uacInterceptionEnabled: true when buildPamConfigUpdate resolves true', async () => {
    const { buildPamConfigUpdate } = await import('./helpers');
    vi.mocked(buildPamConfigUpdate).mockResolvedValueOnce({ uacInterceptionEnabled: true });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.uacInterceptionEnabled).toBe(true);
  });

  // #2930 — the shared policy-config block (event_log / monitoring / pam /
  // patch_source) runs AFTER the org transaction has already committed and
  // its claimed commands are marked delivered. If the outer try/catch around
  // `withSystemDbAccessContext(...)` were removed, a transaction setup/commit
  // failure here (e.g. pool exhaustion under #1105-style connection pressure)
  // would escape as an unhandled rejection and 500 the heartbeat — losing
  // those already-delivered commands for no benefit, since every field this
  // block produces is re-resolved on the next heartbeat anyway. This test
  // pins the fail-safe: only the shared policy-config context is made to
  // reject (targeted by call order — it is the 4th of 5 withSystemDbAccessContext
  // calls per heartbeat: #2123 update-policy, policy-probe, onedrive, THIS
  // ONE, then helper-settings), and the response must still be 200 with all
  // four policy config keys omitted and uacInterceptionEnabled defaulted to
  // false, with the failure reported to Sentry.
  it('returns 200 and omits all four policy config keys when the shared policy-config system context itself fails', async () => {
    const { captureException } = await import('../../services/sentry');

    withSystemDbAccessContextMock
      .mockImplementationOnce(systemDbAccessContextPassthrough) // #2123 update-policy lookup
      .mockImplementationOnce(systemDbAccessContextPassthrough) // policy-probe config
      .mockImplementationOnce(systemDbAccessContextPassthrough) // onedrive settings
      .mockImplementationOnce(async () => {
        throw new Error('shared policy-config system context failed');
      }); // #2930 shared policy-config block — the one under test
    // 5th call (helper settings) falls back to the default pass-through.

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.event_log_settings).toBeUndefined();
    expect(configUpdate?.monitoring_settings).toBeUndefined();
    expect(configUpdate?.patch_source_settings).toBeUndefined();
    expect(body.uacInterceptionEnabled).toBe(false);
    expect(vi.mocked(captureException)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Org > General > Agent update policy: the heartbeat handler must gate the
// agent `upgradeTo` it hands back based on the org's resolved policy. Before
// this wiring the setting was stored but never consulted (agents ignored it).
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — org agent update policy gating', () => {
  const deviceRow = {
    id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
    architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: null,
    lastSeenAt: new Date(), mainAgentSilentSince: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    runOutsideDbContextMock.mockClear();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  async function postAgentHeartbeat() {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.65.10', metrics: minimalHeartbeatBody.metrics }),
    });
  }

  it('manual policy → withholds agent upgradeTo even when a newer version exists', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // latest > reported
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'manual', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });

  it('auto policy with no maintenance window → offers agent upgradeTo when newer exists', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'auto', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBe('0.66.0');
  });

  it('staged policy outside the maintenance window → withholds agent upgradeTo', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    // A window on a different UTC day than "now" guarantees we're outside it.
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const otherDay = days[(new Date().getUTCDay() + 3) % 7];
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'staged', maintenanceWindow: `${otherDay} 02:00-04:00` }, pins: { agent: null, watchdog: null } });
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });

  // #2125 — the update policy is a control-plane safety setting. If the lookup
  // throws the handler cannot prove auto-upgrades are allowed, so it must FAIL
  // CLOSED and withhold the version-to-version agent upgradeTo (a fail-open here
  // would silently bypass Manual mode / a maintenance window on a DB hiccup).
  it('fails closed (withholds upgrade) when the policy lookup throws', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    const { captureException } = await import('../../services/sentry');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockRejectedValueOnce(new Error('db down'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
    // A fleet-wide upgrade freeze must be loud: the lookup failure is reported
    // to Sentry, not just logged (#2125).
    expect(vi.mocked(captureException)).toHaveBeenCalled();
  });

  // #2123 + #1105 — the effective-policy lookup reads the parent partners row,
  // which the org-scoped RLS context (accessiblePartnerIds: []) cannot see, so
  // it MUST run in a system context that opens AND closes BEFORE the org
  // transaction opens (never holding two pooled connections at once). Without
  // this ordering assertion, a regression that moved the lookup back inside the
  // org block — reintroducing both the RLS bug and the #1105 hazard — would
  // pass every other test in this file.
  it('resolves the update policy in a system context that closes before the org context opens', async () => {
    const { getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'auto', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    callOrder.length = 0;

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);

    // First system context = the update-policy lookup; it must enter and exit
    // before the org context opens. (A later system context is the post-block
    // policy-probe read — that one legitimately runs after dbContext:released.)
    const enter = callOrder.indexOf('systemCtx:enter');
    const exit = callOrder.indexOf('systemCtx:exit');
    const opened = callOrder.indexOf('dbContext:opened');
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(enter).toBeLessThan(exit);
    expect(exit).toBeLessThan(opened);
  });

  // A dev-push build (dev-*) must never be auto-upgraded back to a release,
  // regardless of policy. This pins the precedence of the dev-build short
  // circuit relative to the `updateGateAllows` branch (heartbeat.ts:508-511).
  it('dev- agent build is never upgraded even under auto policy', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'auto', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: 'dev-local', metrics: minimalHeartbeatBody.metrics }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });
});

// ---------------------------------------------------------------------
// The same gate also governs the helper and watchdog upgrade channels, and
// must NOT block bootstrap (first-install of a component a device is missing).
// These channels live in separate `if` blocks from the agent upgrade, so they
// get their own coverage — without it a refactor could silently drop the gate
// from one channel (re-introducing the bug this PR fixes) or, conversely,
// start gating bootstrap (stranding devices that never receive a component).
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — helper/watchdog upgrade gating', () => {
  // Device already running a (non-dev) watchdog, so the watchdog path takes the
  // gated version-to-version branch rather than the ungated bootstrap branch.
  const deviceWithWatchdog = {
    id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
    architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: '0.65.0',
    lastSeenAt: new Date(), mainAgentSilentSince: null,
  };
  // Fresh device missing both helper and watchdog — both take the bootstrap
  // branch, which must fire regardless of policy.
  const deviceNeedingBootstrap = {
    id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
    architecture: 'amd64', agentVersion: '0.65.10', watchdogVersion: null,
    lastSeenAt: new Date(), mainAgentSilentSince: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    runOutsideDbContextMock.mockClear();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  // Reports an installed helperVersion so the helper path takes the gated
  // version-to-version branch (not the ungated `!data.helperVersion` bootstrap).
  async function postWithInstalledComponents(deviceRow: typeof deviceWithWatchdog) {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // latest > reported, all components
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'agent', agentVersion: '0.65.10', helperVersion: '0.65.0',
        metrics: minimalHeartbeatBody.metrics,
      }),
    });
  }

  it('manual policy → withholds helper and watchdog version-to-version upgrades', async () => {
    const { getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'manual', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });

    const resp = await postWithInstalledComponents(deviceWithWatchdog);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null };
    expect(body.helperUpgradeTo).toBeFalsy();
    expect(body.watchdogUpgradeTo).toBeFalsy();
  });

  it('auto policy → offers helper and watchdog version-to-version upgrades', async () => {
    const { getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'auto', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });

    const resp = await postWithInstalledComponents(deviceWithWatchdog);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null };
    expect(body.helperUpgradeTo).toBe('0.66.0');
    expect(body.watchdogUpgradeTo).toBe('0.66.0');
  });

  it('manual policy → STILL bootstraps a missing helper and watchdog (bootstrap is ungated)', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'manual', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    selectMock.mockReturnValueOnce(selectChainResolving([deviceNeedingBootstrap]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    // No helperVersion in the body → helper bootstrap branch; watchdogVersion
    // null on the device → watchdog bootstrap branch. Both must fire under manual.
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.65.10', metrics: minimalHeartbeatBody.metrics }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      upgradeTo?: string | null; helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null;
    };
    expect(body.upgradeTo).toBeFalsy(); // agent version-to-version IS gated → withheld
    expect(body.helperUpgradeTo).toBe('0.66.0'); // bootstrap → offered despite manual
    expect(body.watchdogUpgradeTo).toBe('0.66.0'); // bootstrap → offered despite manual
  });

  // #2125 — a policy lookup failure must fail closed on the helper and watchdog
  // version-to-version channels too, not just the main agent channel.
  it('policy lookup failure → withholds helper and watchdog version-to-version upgrades (fail closed)', async () => {
    const { getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(getOrgAgentUpdateConfig).mockRejectedValueOnce(new Error('db down'));

    const resp = await postWithInstalledComponents(deviceWithWatchdog);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null };
    expect(body.helperUpgradeTo).toBeFalsy();
    expect(body.watchdogUpgradeTo).toBeFalsy();
  });

  // Fail-closed must not strand fresh devices on the UNPINNABLE helper channel:
  // a missing helper still bootstraps even when the policy lookup throws. The
  // WATCHDOG channel is pinnable (#2124), so its bootstrap is withheld until the
  // pins resolve — see the next test for why.
  it('policy lookup failure → STILL bootstraps a missing helper (unpinnable channel)', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockRejectedValueOnce(new Error('db down'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceNeedingBootstrap]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.65.10', metrics: minimalHeartbeatBody.metrics }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      upgradeTo?: string | null; helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null;
    };
    expect(body.upgradeTo).toBeFalsy(); // agent version-to-version gated → withheld
    expect(body.helperUpgradeTo).toBe('0.66.0'); // bootstrap → offered despite lookup failure
  });

  // #2124 — the WATCHDOG bootstrap IS withheld when the version-pin lookup fails.
  // The upgrade channel is upgrade-only (`cmp > 0`), so it can never walk back a
  // wrong-version bootstrap: if the org pinned an OLDER known-good watchdog and
  // we bootstrap global latest because we couldn't read the pin, the device is
  // permanently stranded above the pin. Fail closed and self-heal next heartbeat.
  it('policy lookup failure → WITHHOLDS the missing-watchdog bootstrap (pin unresolved, fail closed)', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdateConfig).mockRejectedValueOnce(new Error('db down'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceNeedingBootstrap]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.65.10', metrics: minimalHeartbeatBody.metrics }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { watchdogUpgradeTo?: string | null };
    expect(body.watchdogUpgradeTo).toBeFalsy(); // withheld: pin could not be confirmed
  });
});

// ---------------------------------------------------------------------
// #1802 — main agent reports the installed watchdog version in its normal
// heartbeat so devices.watchdog_version stays fresh after the watchdog
// recovers (it was previously written only from FAILOVER heartbeats).
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — watchdogVersion telemetry (#1802)', () => {
  // device.watchdogVersion is intentionally STALE here ('0.65.0') to model a
  // watchdog that was swapped to 0.66.0 and recovered to monitoring, so the old
  // failover-only telemetry never updated the column.
  const deviceRow = {
    id: 'device-1', orgId: 'org-1', siteId: 'site-1', hostname: 'host',
    osType: 'windows', architecture: 'amd64', agentVersion: '0.66.0',
    watchdogVersion: '0.65.0', deviceRoleSource: 'auto',
    lastSeenAt: new Date(), mainAgentSilentSince: null,
  };

  const realishCompare = (a: string, b: string) => (a === b ? 0 : a > b ? 1 : -1);

  function arrange(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  }

  async function post(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', metrics: minimalHeartbeatBody.metrics, ...body }),
    });
  }

  it('persists the watchdogVersion the main agent reports to the device row', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);

    const resp = await post({ agentVersion: '0.66.0', watchdogVersion: '0.66.0' });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.watchdogVersion).toBe('0.66.0');
  });

  it('leaves the stored watchdogVersion untouched when an old agent omits it', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);

    const resp = await post({ agentVersion: '0.66.0' });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('watchdogVersion');
  });

  it('uses the reported version (not the stale column) to suppress redundant re-sends', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'auto', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    vi.mocked(compareAgentVersions).mockImplementation(realishCompare);

    // Stale column is '0.65.0' (would trigger an upgrade); the agent now reports
    // the current '0.66.0', which must NOT.
    const resp = await post({ agentVersion: '0.66.0', watchdogVersion: '0.66.0' });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { watchdogUpgradeTo?: string | null };
    expect(body.watchdogUpgradeTo).toBeFalsy();
  });

  it('still upgrades when the reported watchdogVersion is genuinely behind latest', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig } = await import('./helpers');
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({ settings: { policy: 'auto', maintenanceWindow: null }, pins: { agent: null, watchdog: null } });
    vi.mocked(compareAgentVersions).mockImplementation(realishCompare);

    const resp = await post({ agentVersion: '0.66.0', watchdogVersion: '0.65.0' });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { watchdogUpgradeTo?: string | null };
    expect(body.watchdogUpgradeTo).toBe('0.66.0');
  });
});

describe('POST /agents/:id/heartbeat — backupVersion telemetry', () => {
  // Mirrors the watchdogVersion telemetry suite above (#1802): breeze-backup
  // is a separate agent-shipped component, so devices.backup_version is kept
  // fresh from the same heartbeat field, with no server-driven upgrade path
  // (unlike watchdog, there is no backupUpgradeTo in the response).
  const deviceRow = {
    id: 'device-1', orgId: 'org-1', siteId: 'site-1', hostname: 'host',
    osType: 'windows', architecture: 'amd64', agentVersion: '0.66.0',
    backupVersion: '0.65.0', deviceRoleSource: 'auto',
    lastSeenAt: new Date(), mainAgentSilentSince: null,
  };

  function arrange(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  }

  async function post(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', metrics: minimalHeartbeatBody.metrics, ...body }),
    });
  }

  it('persists the backupVersion the agent reports to the device row', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);

    const resp = await post({ agentVersion: '0.66.0', backupVersion: '0.66.0' });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.backupVersion).toBe('0.66.0');
  });

  it('leaves the stored backupVersion untouched when the agent omits it (old agent, or breeze-backup not installed)', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);

    const resp = await post({ agentVersion: '0.66.0' });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('backupVersion');
  });
});

describe('POST /agents/:id/heartbeat — rollback component inventory', () => {
  const deviceRow = {
    id: 'device-1', orgId: 'org-1', siteId: 'site-1', hostname: 'host',
    osType: 'windows', architecture: 'amd64', agentVersion: '0.66.0',
    deviceRoleSource: 'auto', lastSeenAt: new Date(), mainAgentSilentSince: null,
  };

  function arrange(setSpy: ReturnType<typeof vi.fn>) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  }

  async function post(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', metrics: minimalHeartbeatBody.metrics, ...body }),
    });
  }

  it('persists the complete claimed inventory', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);
    const inventory = { agent: '0.66.0', helper: '0.66.0', 'user-helper': '0.66.0' };
    const resp = await post({
      agentVersion: '0.66.0',
      securityCapabilities: { rollbackProtocolVersion: 1 },
      rollbackComponentVersions: inventory,
    });
    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.rollbackComponentVersions).toEqual(inventory);
  });

  it('clears stale inventory when a protocol-v1 agent cannot prove completeness', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    arrange(setSpy);
    const resp = await post({
      agentVersion: '0.66.0',
      securityCapabilities: { rollbackProtocolVersion: 1 },
    });
    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.rollbackComponentVersions).toBeNull();
  });
});

// ---------------------------------------------------------------------
// #2288 — active control-plane URL persistence
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — active server URL telemetry (#2288)', () => {
  const deviceRow = {
    id: 'device-1', orgId: 'org-1', siteId: 'site-1', hostname: 'host',
    osType: 'windows', architecture: 'amd64', agentVersion: '0.66.0',
    deviceRoleSource: 'auto', lastSeenAt: new Date(), mainAgentSilentSince: null,
  };

  let capturedDeviceUpdate: Record<string, unknown>;

  function arrange() {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([]));
    updateMock.mockReturnValue({
      set: vi.fn((values: Record<string, unknown>) => {
        capturedDeviceUpdate = values;
        return { where: vi.fn(() => whereResultWithReturning()) };
      }),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  }

  async function postHeartbeat(body: Record<string, unknown>) {
    arrange();
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('persists a valid serverUrl to devices.agent_server_url', async () => {
    await postHeartbeat({ ...minimalHeartbeatBody, serverUrl: 'https://old.example.com' });
    expect(capturedDeviceUpdate.agentServerUrl).toBe('https://old.example.com');
  });

  it('ignores a malformed serverUrl instead of failing the heartbeat', async () => {
    const res = await postHeartbeat({ ...minimalHeartbeatBody, serverUrl: 'not a url' });
    expect(res.status).toBe(200);
    expect(capturedDeviceUpdate.agentServerUrl).toBeUndefined();
  });

  it('drops parseable-but-non-http(s) serverUrl schemes (value is echoed into the web UI)', async () => {
    const res = await postHeartbeat({ ...minimalHeartbeatBody, serverUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(200);
    expect(capturedDeviceUpdate.agentServerUrl).toBeUndefined();
  });

  it('leaves stored value untouched when serverUrl absent (old agent)', async () => {
    await postHeartbeat(minimalHeartbeatBody);
    expect(Object.hasOwn(capturedDeviceUpdate, 'agentServerUrl')).toBe(false);
  });
});

// ---------------------------------------------------------------------
// #1387 — orthogonal virtualization attribute persistence
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — virtualization attribute (#1387)', () => {
  function arrange(deviceOverrides: Record<string, unknown> = {}) {
    vi.clearAllMocks();
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'windows',
          osVersion: 'Microsoft Windows 11 Pro',
          osBuild: null,
          architecture: 'amd64',
          agentVersion: '0.65.10',
          deviceRole: 'workstation',
          deviceRoleSource: 'auto',
          isVirtual: false,
          virtualizationPlatform: null,
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
          ...deviceOverrides,
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
    return setSpy;
  }

  async function beat(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, ...body }),
    });
  }

  it('persists isVirtual=true + platform when the agent reports a hypervisor', async () => {
    const setSpy = arrange();
    const resp = await beat({ isVirtual: true, virtualizationPlatform: 'vmware' });
    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.isVirtual).toBe(true);
    expect(updateArg.virtualizationPlatform).toBe('vmware');
  });

  it('clears the platform to NULL when the agent reports isVirtual=false', async () => {
    const setSpy = arrange({ isVirtual: true, virtualizationPlatform: 'hyperv' });
    await beat({ isVirtual: false });
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.isVirtual).toBe(false);
    expect(updateArg.virtualizationPlatform).toBeNull();
  });

  it('clears the platform to NULL when isVirtual=true but no platform is identified', async () => {
    const setSpy = arrange();
    await beat({ isVirtual: true });
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.isVirtual).toBe(true);
    expect(updateArg.virtualizationPlatform).toBeNull();
  });

  it('leaves stored virtualization untouched when an old agent omits the field', async () => {
    const setSpy = arrange({ isVirtual: true, virtualizationPlatform: 'vmware' });
    await beat({}); // no isVirtual in payload (also covers the agent's not-yet-classified startup window, where IsVirtual is nil)
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.isVirtual).toBeUndefined();
    expect(updateArg.virtualizationPlatform).toBeUndefined();
  });

  it('persists virtualization independently of deviceRoleSource (admin-pinned role still updates the axis)', async () => {
    // A VDI box with an operator-pinned role (deviceRoleSource='manual') must
    // still have its orthogonal virtualization axis updated — the two are
    // independent. Guards against a future refactor folding both under the
    // deviceRole 'auto' gate.
    const setSpy = arrange({ deviceRoleSource: 'manual', deviceRole: 'server' });
    await beat({ deviceRole: 'workstation', isVirtual: true, virtualizationPlatform: 'vmware' });
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    // Role NOT updated (source is manual)...
    expect(updateArg.deviceRole).toBeUndefined();
    // ...but virtualization IS.
    expect(updateArg.isVirtual).toBe(true);
    expect(updateArg.virtualizationPlatform).toBe('vmware');
  });

  // NOTE: schema-level coercion (e.g. an unrecognized platform string being
  // dropped to undefined by .catch) is asserted against the real schema in
  // schemas.test.ts — this route test mocks zValidator out, so the handler
  // here only ever sees already-validated `data`.
});

// ---------------------------------------------------------------------
// #2124 — version-pin threading: the AGENT branch must receive the agent
// pin and the WATCHDOG branch the watchdog pin. Kept at the end of the file
// because these tests set resolvePinnedUpgradeTarget's implementation, which
// vi.clearAllMocks() does NOT restore — a swap-guard regression that would
// otherwise pass the whole suite (both branches call the same resolver).
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — version-pin threading (#2124)', () => {
  const deviceRow = {
    id: 'device-1', orgId: 'org-1', siteId: 'site-1', hostname: 'host',
    osType: 'windows', architecture: 'amd64', agentVersion: '0.66.0',
    watchdogVersion: '0.65.0', deviceRoleSource: 'auto',
    lastSeenAt: new Date(), mainAgentSilentSince: null,
  };
  const realishCompare = (a: string, b: string) => (a === b ? 0 : a > b ? 1 : -1);

  function arrange() {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));
    updateMock.mockReturnValue({ set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })) });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  }

  async function post(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', metrics: minimalHeartbeatBody.metrics, ...body }),
    });
  }

  it('threads the agent pin to the agent resolve and the watchdog pin to the watchdog resolve (no cross-wiring)', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig, resolvePinnedUpgradeTarget } = await import('./helpers');
    arrange();
    vi.mocked(compareAgentVersions).mockImplementation(realishCompare);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'auto', maintenanceWindow: null },
      pins: { agent: '0.90.0', watchdog: '0.91.0' },
    });
    vi.mocked(resolvePinnedUpgradeTarget).mockImplementation(
      async ({ component }: { component: string }) => (component === 'agent' ? '0.90.0' : '0.91.0'),
    );

    const resp = await post({ agentVersion: '0.66.0', watchdogVersion: '0.65.0' });
    expect(resp.status).toBe(200);

    const calls = vi.mocked(resolvePinnedUpgradeTarget).mock.calls.map((c) => c[0] as any);
    const agentCall = calls.find((a) => a.component === 'agent');
    const watchdogCall = calls.find((a) => a.component === 'watchdog');

    // Each branch gets ITS OWN pin + the device's real platform/arch.
    expect(agentCall).toMatchObject({ component: 'agent', pin: '0.90.0', platform: 'windows', architecture: 'amd64' });
    expect(watchdogCall).toMatchObject({ component: 'watchdog', pin: '0.91.0', platform: 'windows', architecture: 'amd64' });
    // Regression guard: a swapped wiring would pass the version comparisons but
    // hand the agent branch the watchdog pin (and vice-versa).
    expect(agentCall?.pin).not.toBe('0.91.0');
    expect(watchdogCall?.pin).not.toBe('0.90.0');
  });

  it('fails closed: a null pinned target on the watchdog branch withholds watchdogUpgradeTo', async () => {
    const { compareAgentVersions, getOrgAgentUpdateConfig, resolvePinnedUpgradeTarget } = await import('./helpers');
    arrange();
    vi.mocked(compareAgentVersions).mockImplementation(realishCompare);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'auto', maintenanceWindow: null },
      pins: { agent: null, watchdog: '0.91.0' },
    });
    // The pinned watchdog version has no build for this platform/arch → the
    // resolver fails closed to null, so no watchdog upgrade is offered even
    // though the reported 0.65.0 is behind.
    vi.mocked(resolvePinnedUpgradeTarget).mockImplementation(
      async ({ component }: { component: string }) => (component === 'watchdog' ? null : '0.66.0'),
    );

    const resp = await post({ agentVersion: '0.66.0', watchdogVersion: '0.65.0' });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { watchdogUpgradeTo?: string | null };
    expect(body.watchdogUpgradeTo).toBeFalsy();
  });
});

// Regression coverage for #2230 — see the updateDeviceStatus() doc comment in
// routes/agentWs.ts for the full incident writeup. The REST heartbeat is the
// polling counterpart: agentAuthMiddleware 403s terminal-status devices up
// front, but a decommission landing mid-request must not be flipped back to
// 'online' by the devices write at the end of the handler.
describe('POST /agents/:id/heartbeat — terminal-status guard (#2230)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    runOutsideDbContextMock.mockClear();
    getActiveTrustKeysetMock.mockReset();
    getActiveTrustKeysetMock.mockResolvedValue([]);
  });

  it('the devices status write excludes decommissioned/quarantined rows', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host',
          osType: 'windows',
          architecture: 'amd64',
          agentVersion: '0.65.15',
          deviceRoleSource: 'auto',
          mainAgentSilentSince: null,
        },
      ]),
    );
    // Guarded write matches 0 rows (device is terminal-status) → `.returning()`
    // yields an empty array, which must suppress the state-transition audit.
    const whereSpy = vi.fn(() => whereResultWithReturning([]));
    const setSpy = vi.fn(() => ({ where: whereSpy }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });
    expect(resp.status).toBe(200);

    // The first devices update is the deviceUpdates write.
    const firstSet = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(firstSet.status).toBe('online');
    expect((whereSpy.mock.calls as any[])[0]?.[0]).toEqual(
      and(eq(devices.id, 'device-1'), notInArray(devices.status, ['decommissioned', 'quarantined'])),
    );

    // Finding #10: a guard-rejected (0-row) write must NOT record a phantom
    // state transition.
    const { writeAuditEvent } = await import('../../services/auditEvents');
    expect(vi.mocked(writeAuditEvent)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'agent.heartbeat.state_change' }),
    );
  });
});

// ---------------------------------------------------------------------
// Finding #10 — durable audit of security-relevant heartbeat state changes.
// The main-agent heartbeat mutates several security-relevant device fields
// (status, hostname, agentServerUrl, tcc/desktop access, main-agent-silent
// recovery) but previously left no persisted trail. These tests assert one
// content-minimal `agent.heartbeat.state_change` audit fires ONLY on a genuine
// transition, and NOT on a steady-state beat.
// ---------------------------------------------------------------------
describe('POST /agents/:id/heartbeat — state-change audit (finding #10)', () => {
  // Steady-state baseline the handler will diff against. status already online,
  // hostname/agentServerUrl/tcc/desktop already match what a steady beat sends.
  const baselineDevice = {
    id: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: 'host-1',
    osType: 'linux',
    osVersion: 'Ubuntu 22.04',
    osBuild: null,
    architecture: 'amd64',
    agentVersion: '0.65.10',
    deviceRole: 'server',
    deviceRoleSource: 'auto',
    agentTokenHash: 'hash',
    tokenIssuedAt: new Date(),
    status: 'online',
    agentServerUrl: 'https://cp.example.com',
    tccPermissions: { screenRecording: 'granted' },
    desktopAccess: { level: 'full' },
    mainAgentSilentSince: null,
  };

  function arrange(deviceOverrides: Record<string, unknown> = {}) {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    selectMock.mockReturnValueOnce(
      selectChainResolving([{ ...baselineDevice, ...deviceOverrides }]),
    );
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning([{ id: 'device-1' }])) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
  }

  async function beat(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function auditCalls() {
    const { writeAuditEvent } = await import('../../services/auditEvents');
    return vi
      .mocked(writeAuditEvent)
      .mock.calls.filter((c) => (c[1] as { action?: string })?.action === 'agent.heartbeat.state_change');
  }

  it('offline→online emits exactly one state_change audit carrying before/after status', async () => {
    arrange({ status: 'offline' });

    const resp = await beat({
      ...minimalHeartbeatBody,
      hostname: 'host-1', // unchanged
      serverUrl: 'https://cp.example.com', // unchanged
      tccPermissions: { screenRecording: 'granted' }, // unchanged
      desktopAccess: { level: 'full' }, // unchanged
    });
    expect(resp.status).toBe(200);

    const calls = await auditCalls();
    expect(calls).toHaveLength(1);
    const details = (calls[0]![1] as unknown as { details: { changes: any[] } }).details;
    expect(details.changes).toEqual([{ field: 'status', before: 'offline', after: 'online' }]);
    // Actor/resource shape mirrors the co-located threshold-scan audit.
    expect(calls[0]![1]).toMatchObject({
      orgId: 'org-1',
      actorType: 'agent',
      actorId: 'device-1', // = the :id path param (agentId), mirroring the threshold-scan audit
      resourceType: 'device',
      resourceId: 'device-1',
    });
  });

  it('hostname change emits a state_change audit with before/after', async () => {
    arrange(); // status already online, hostname host-1
    const resp = await beat({ ...minimalHeartbeatBody, hostname: 'renamed-host' });
    expect(resp.status).toBe(200);

    const calls = await auditCalls();
    expect(calls).toHaveLength(1);
    const changes = (calls[0]![1] as unknown as { details: { changes: any[] } }).details.changes;
    expect(changes).toContainEqual({ field: 'hostname', before: 'host-1', after: 'renamed-host' });
  });

  it('agentServerUrl change emits a state_change audit with before/after', async () => {
    arrange();
    const resp = await beat({ ...minimalHeartbeatBody, serverUrl: 'https://new-cp.example.com' });
    expect(resp.status).toBe(200);

    const changes = (await auditCalls())[0]?.[1] as unknown as { details: { changes: any[] } };
    expect(changes.details.changes).toContainEqual({
      field: 'agentServerUrl',
      before: 'https://cp.example.com',
      after: 'https://new-cp.example.com',
    });
  });

  it('tccPermissions change emits a state_change audit', async () => {
    arrange();
    const resp = await beat({
      ...minimalHeartbeatBody,
      tccPermissions: { screenRecording: 'denied' },
    });
    expect(resp.status).toBe(200);

    const changes = ((await auditCalls())[0]?.[1] as unknown as { details: { changes: any[] } }).details.changes;
    expect(changes).toContainEqual({
      field: 'tccPermissions',
      before: { screenRecording: 'granted' },
      after: { screenRecording: 'denied' },
    });
  });

  it('desktopAccess change emits a state_change audit', async () => {
    arrange();
    const resp = await beat({
      ...minimalHeartbeatBody,
      desktopAccess: { level: 'restricted' },
    });
    expect(resp.status).toBe(200);

    const changes = ((await auditCalls())[0]?.[1] as unknown as { details: { changes: any[] } }).details.changes;
    expect(changes).toContainEqual({
      field: 'desktopAccess',
      before: { level: 'full' },
      after: { level: 'restricted' },
    });
  });

  it('main-agent recovery (mainAgentSilentSince non-null→null) emits a mainAgentSilent transition', async () => {
    arrange({ mainAgentSilentSince: new Date(Date.now() - 5 * 60 * 1000) });
    const resp = await beat({
      ...minimalHeartbeatBody,
      hostname: 'host-1',
      serverUrl: 'https://cp.example.com',
      tccPermissions: { screenRecording: 'granted' },
      desktopAccess: { level: 'full' },
    });
    expect(resp.status).toBe(200);

    const changes = ((await auditCalls())[0]?.[1] as unknown as { details: { changes: any[] } }).details.changes;
    expect(changes).toContainEqual({ field: 'mainAgentSilent', before: true, after: false });
  });

  it('steady-state heartbeat (nothing security-relevant changed) emits NO audit', async () => {
    arrange(); // baseline already online with matching fields
    const resp = await beat({
      ...minimalHeartbeatBody,
      // Re-report identical values — must not be treated as changes.
      hostname: 'host-1',
      serverUrl: 'https://cp.example.com',
      tccPermissions: { screenRecording: 'granted' },
      desktopAccess: { level: 'full' },
    });
    expect(resp.status).toBe(200);

    expect(await auditCalls()).toHaveLength(0);
  });

  it('batches multiple simultaneous changes into a single audit event', async () => {
    arrange({ status: 'offline' });
    const resp = await beat({
      ...minimalHeartbeatBody,
      hostname: 'renamed-host',
      serverUrl: 'https://new-cp.example.com',
    });
    expect(resp.status).toBe(200);

    const calls = await auditCalls();
    expect(calls).toHaveLength(1); // ONE event, not three
    const fields = (calls[0]![1] as unknown as { details: { changes: any[] } }).details.changes.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(['status', 'hostname', 'agentServerUrl']));
  });
});

describe('POST /agents/:id/heartbeat — agentRuntime gauges (#2389)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Device lookup → returns a row
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          osVersion: 'Ubuntu 22.04',
          osBuild: null,
          architecture: 'amd64',
          agentVersion: '0.65.10',
          deviceRole: 'server',
          deviceRoleSource: 'auto',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );

    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => whereResultWithReturning()),
      })),
    });

    selectMock.mockReturnValue(selectChainResolving([]));
    getActiveTrustKeysetMock.mockResolvedValue([]);
  });

  // Finds the deviceMetrics insert among all insert calls by its cpuPercent
  // marker column, so an unrelated insert (audit, agent logs) can't be
  // mistaken for it.
  function findMetricsInsert(valuesSpy: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
    return valuesSpy.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((v) => v && typeof v === 'object' && 'cpuPercent' in v);
  }

  it('persists agentRuntime into device_metrics.custom_metrics', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesSpy });

    const agentRuntime = {
      heapAllocBytes: 12_345_678,
      heapInuseBytes: 23_456_789,
      heapReleasedBytes: 1_048_576,
      sysBytes: 99_999_999,
      numGc: 42,
      goroutines: 87,
    };

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, agentRuntime }),
    });

    expect(resp.status).toBe(200);
    const metricsInsert = findMetricsInsert(valuesSpy);
    expect(metricsInsert).toBeDefined();
    expect(metricsInsert?.customMetrics).toEqual({ agentRuntime });
  });

  it('writes customMetrics: null when an old agent omits agentRuntime', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesSpy });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const metricsInsert = findMetricsInsert(valuesSpy);
    expect(metricsInsert).toBeDefined();
    expect(metricsInsert?.customMetrics).toBeNull();
  });

  // NOTE: schema-level tolerance (malformed agentRuntime dropped via .catch)
  // is covered in schemas.heartbeatTolerance.test.ts — this route test mocks
  // zValidator out, so the handler never sees schema-dropped fields.

  it('warns loudly (no metrics insert) when agentRuntime arrives without metrics', async () => {
    // The gauges ride the device_metrics insert; when OS metrics collection
    // failed there is no row to attach them to, and that drop must be
    // observable (see #2389 review) — not silent.
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesSpy });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { metrics: _omitted, ...noMetricsBody } = minimalHeartbeatBody;
      const resp = await buildApp().request('/agents/device-1/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...noMetricsBody,
          metricsAvailable: false,
          agentRuntime: {
            heapAllocBytes: 1,
            heapInuseBytes: 2,
            heapReleasedBytes: 3,
            sysBytes: 4,
            numGc: 5,
            goroutines: 6,
          },
        }),
      });

      expect(resp.status).toBe(200);
      expect(findMetricsInsert(valuesSpy)).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('agentRuntime received without metrics'),
        expect.objectContaining({ deviceId: 'device-1', goroutines: 6 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('POST /agents/:id/heartbeat — undecryptable claimed commands are released, siblings deliver (#2414)', () => {
  const claimedAt = new Date('2026-07-13T00:00:00Z');
  const goodCommand = {
    id: 'cmd-good',
    type: 'run_script',
    payload: { scriptId: 'script-1' },
    executedAt: claimedAt,
  };
  // A well-formed-looking but undecryptable sensitive payload (e.g. after an
  // APP_ENCRYPTION_KEY rotation) — the real services/commandDelivery +
  // sensitiveCommandPayload modules run here, so decryption genuinely fails.
  const undecryptableCommand = {
    id: 'cmd-bad',
    type: 'encryption_rotate_key',
    payload: { password: 'enc:v3:deadbeef:not-real-ciphertext' },
    executedAt: claimedAt,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getActiveTrustKeysetMock.mockResolvedValue([]);
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('agent path: releases the undecryptable command back to pending and still delivers its sibling', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          agentVersion: '0.65.10',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([goodCommand, undecryptableCommand]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { commands: Array<{ id: string }> };
    // The decryptable sibling still delivers; the undecryptable one is dropped
    // from the response...
    expect(body.commands.map((cmd) => cmd.id)).toEqual(['cmd-good']);
    // ...and released back to pending (NOT stranded as 'sent' awaiting a
    // misattributed agent-timeout reap).
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-bad', claimedAt);
    const { captureException } = await import('../../services/sentry');
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('commandId=cmd-bad'),
      }),
    );
  });

  it('watchdog path: releases the undecryptable command back to pending and still delivers its sibling', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          lastSeenAt: new Date(),
          mainAgentSilentSince: null,
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([goodCommand, undecryptableCommand]);

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.15', role: 'watchdog', watchdogState: 'MONITORING' }),
    });

    expect(resp.status).toBe(200);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith('device-1', 10, 'watchdog', undefined);
    const body = (await resp.json()) as { commands: Array<{ id: string }> };
    expect(body.commands.map((cmd) => cmd.id)).toEqual(['cmd-good']);
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-bad', claimedAt);
  });

  it('agent path: normal delivery is untouched — every claimed command decrypts, nothing is released', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          agentVersion: '0.65.10',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([goodCommand]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { peripheralPolicyProtocolVersion: 2, rollbackProtocolVersion: 1, pamLifetimeProtocolVersion: 2 },
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { commands: Array<{ id: string; type: string; payload: unknown }> };
    expect(body.commands).toEqual([
      { id: 'cmd-good', type: 'run_script', payload: { scriptId: 'script-1' } },
    ]);
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith(
      'device-1', 10, 'agent', undefined,
      { peripheralPolicyProtocolVersion: 2, rollbackProtocolVersion: 1, pamLifetimeProtocolVersion: 2 },
    );
  });

  // #2774 — the heartbeat is the PRIMARY command carrier (the GET poll is
  // watchdog-failover only), so this is the filter that actually stops a
  // departing customer's machines from executing scripts/automations queued
  // by workers AFTER drain entry cancelled the then-pending set.
  it('agent path: narrows the claim to self_uninstall when the tenant is draining', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          agentVersion: '0.65.10',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([]);

    const resp = await buildDrainingApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith(
      'device-1',
      10,
      'agent',
      ['self_uninstall'],
      { peripheralPolicyProtocolVersion: 0, rollbackProtocolVersion: 0, pamLifetimeProtocolVersion: 0 },
    );
  });

  // #3409 PR4c-2 Amendment A — the claim gate trusts the capability THIS
  // heartbeat REPORTED, not the stored column. The device write that persists
  // it is guarded on the device not being decommissioned/quarantined and is a
  // separate statement from the claim, so a stale stored 1 must never win over
  // a reported 0. Proven by asserting the capability SELECT never happens:
  // the only possible source of the verdict is the reported value.
  const capabilitySelects = () =>
    selectMock.mock.calls.filter(
      (call) => call[0] && typeof call[0] === 'object' && 'scriptSecretEnvVersion' in (call[0] as object),
    );

  const secretCommand = {
    id: 'cmd-secret',
    type: 'script',
    deviceId: 'device-1',
    payload: { scriptId: 'script-1', secretEnvEnvelope: 'enc:v3:key-1:ciphertext' },
    executedAt: claimedAt,
  };

  const seedAgentDeviceLookup = () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          agentVersion: '0.65.10',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
  };

  it('agent path: withholds a secret-bearing command when THIS beat reports capability 0', async () => {
    seedAgentDeviceLookup();
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([goodCommand, secretCommand]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { scriptSecretEnvVersion: 0 },
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { commands: Array<{ id: string }> };
    expect(body.commands.map((cmd) => cmd.id)).toEqual(['cmd-good']);
    expect(JSON.stringify(body)).not.toContain('secretEnvEnvelope');
    // Terminal, NOT released back to pending — an incapable agent would just
    // re-claim it.
    expect(releaseClaimedCommandDeliveryMock).not.toHaveBeenCalled();
    // The verdict came from the report, not from a (possibly stale) read.
    expect(capabilitySelects()).toHaveLength(0);
  });

  // Capability 1: the gate must NOT withhold. The stand-in envelope here is not
  // decryptable (no keyring in this suite), so the command then falls into the
  // ordinary #2414 decrypt-failure path — being RELEASED back to pending is
  // precisely the proof that the gate passed it through instead of driving it
  // terminal, which is the one thing the gate would have done at capability 0.
  it('agent path: passes the secret-bearing command through the gate when THIS beat reports capability 1, with no capability read', async () => {
    seedAgentDeviceLookup();
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([goodCommand, secretCommand]);

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...minimalHeartbeatBody,
        securityCapabilities: { scriptSecretEnvVersion: 1 },
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { commands: Array<{ id: string }> };
    expect(body.commands.map((cmd) => cmd.id)).toEqual(['cmd-good']);
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-secret', claimedAt);
    expect(capabilitySelects()).toHaveLength(0);
  });

  it('watchdog path: withholds a secret-bearing command when the beat reports capability 0', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          lastSeenAt: new Date(),
          mainAgentSilentSince: null,
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([goodCommand, secretCommand]);

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.15', role: 'watchdog', watchdogState: 'MONITORING' }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { commands: Array<{ id: string }> };
    expect(body.commands.map((cmd) => cmd.id)).toEqual(['cmd-good']);
    expect(capabilitySelects()).toHaveLength(0);
  });

  it('watchdog path: narrows the claim to self_uninstall when the tenant is draining', async () => {
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          lastSeenAt: new Date(),
          mainAgentSilentSince: null,
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([]);

    const resp = await buildDrainingApp('watchdog').request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentVersion: '0.65.15', role: 'watchdog', watchdogState: 'MONITORING' }),
    });

    expect(resp.status).toBe(200);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith('device-1', 10, 'watchdog', [
      'self_uninstall',
    ]);
  });
});

// #2434 — the service/process monitoring ingest persists an agent-supplied
// free-form `details` blob straight into a jsonb column that the monitoring UI
// renders. It is a separate REST ingest from the command-result path, so the
// command-result chokepoint never sees it.
describe('PUT /:id/monitoring-results — secret redaction (#2434)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redacts secrets from agent-supplied check details before persistence', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

    // device lookup by agentId
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: 'device-1', orgId: 'org-1', siteId: 'site-1' },
          ]),
        }),
      }),
    });

    const values = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values });

    const res = await buildApp().request('/agents/agent-1/monitoring-results', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        results: [{
          watchType: 'service',
          name: 'sshd',
          status: 'error',
          details: {
            lastError: `service failed to start:\n${pem}`,
            nested: { hint: `config holds:\n${pem}` },
          },
        }],
      }),
    });

    expect(res.status).toBe(200);
    expect(values).toHaveBeenCalledTimes(1);

    const inserted = values.mock.calls[0]![0] as Array<{ details: Record<string, any> }>;
    expect(inserted[0]!.details.lastError).toContain('[PRIVATE_KEY_REDACTED]');
    expect(inserted[0]!.details.nested.hint).toContain('[PRIVATE_KEY_REDACTED]');

    const serialized = JSON.stringify(inserted);
    expect(serialized).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(serialized).not.toContain('MIIBOgIBAAJBAKe0m0h');
  });
});

// #3986 Layer 4 — the MINIMAL DRAIN BEAT. Being on the drain ROUTE allowlist is
// not the same as being harmless: the normal heartbeat both INGESTS (metrics,
// IP history, OneDrive state, threshold-scan command creation, audit events)
// and CONFIGURES (configUpdate, three upgrade targets, manifest trust keys +
// delegations, renewCert, rotateToken). A removed machine must get none of it.
describe('POST /agents/:id/heartbeat — device-remove uninstall drain (#3986)', () => {
  const claimedAt = new Date('2026-08-25T00:00:00.000Z');
  const uninstallCommand = {
    id: 'cmd-uninstall',
    type: 'self_uninstall',
    deviceId: 'device-1',
    payload: { removeConfig: true },
    executedAt: claimedAt,
  };

  // A heartbeat body that would exercise EVERY ingest branch of the normal
  // path, so "nothing was written" is a real assertion rather than a
  // consequence of an empty payload.
  const richHeartbeatBody = {
    agentVersion: '0.65.10',
    hostname: 'renamed-host',
    osVersion: 'Ubuntu 24.04',
    metrics: {
      cpuPercent: 99,
      ramPercent: 99,
      ramUsedMb: 4096,
      diskPercent: 99,
      diskUsedGb: 500,
    },
    ipHistoryUpdate: { deviceId: 'device-1', currentIPs: ['10.0.0.9'] },
    onedriveDeviceState: {
      signedIn: true,
      filesOnDemandOn: true,
      kfmFolderStates: {},
      mountedLibraries: [],
      entitledLibraries: [],
      signedInUpns: ['user@example.com'],
      driftEntries: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    getActiveTrustKeysetMock.mockReset();
    getActiveManifestKeyDelegationsMock.mockReset();
    // Deliberately armed with values the normal path WOULD return, so a
    // regression that falls through to it produces a loudly non-empty body.
    getActiveTrustKeysetMock.mockResolvedValue([
      { keyId: 'k-1', publicKeyB64: 'AAA=', validFrom: '2026-01-01T00:00:00.000Z' },
    ]);
    getActiveManifestKeyDelegationsMock.mockResolvedValue([{ keyId: 'k-1' }]);
    // A VALID device row for every select, so a regression that falls through
    // to the normal path actually runs it end-to-end (ingest writes, upgrade
    // resolution, config build) instead of bailing out at a 404 and passing
    // the "wrote nothing" assertions by accident.
    selectMock.mockReturnValue(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          agentVersion: '0.65.10',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    claimPendingCommandsForDeviceMock.mockResolvedValue([]);
  });

  async function drainBeat(body: unknown = richHeartbeatBody) {
    return buildDeviceDrainApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns only self_uninstall — no config, upgrades, trust keys or rotation — in a drain heartbeat', async () => {
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([uninstallCommand]);

    const resp = await drainBeat();

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;

    // The uninstall IS delivered — that is the entire point of the window.
    expect((body.commands as Array<{ id: string; type: string }>).map((cmd) => cmd.type)).toEqual([
      'self_uninstall',
    ]);

    // ...and the response carries NOTHING the Go agent would act on. Asserted
    // as an exact key set, not key-by-key: a future field added to the normal
    // response must not be able to leak in unnoticed.
    expect(Object.keys(body)).toEqual(['commands']);
  });

  it('claims with the derived self_uninstall allowlist and nothing wider', async () => {
    await drainBeat();

    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledTimes(1);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith('device-1', 10, 'agent', [
      'self_uninstall',
    ]);
  });

  it('writes NOTHING: no device update, no metrics/OneDrive insert, no audit event', async () => {
    await drainBeat();

    // No devices UPDATE — which is what keeps the machine reading as "Removed"
    // in the UI (no status flip back to online, no lastSeenAt bump).
    expect(updateMock).not.toHaveBeenCalled();
    // No device_metrics row, no onedrive_device_state upsert, no agent_logs.
    expect(insertMock).not.toHaveBeenCalled();

    const { writeAuditEvent } = await import('../../services/auditEvents');
    expect(writeAuditEvent).not.toHaveBeenCalled();

    const { processDeviceIPHistoryUpdate } = await import('../../services/deviceIpHistory');
    expect(processDeviceIPHistoryUpdate).not.toHaveBeenCalled();
  });

  it('creates no threshold filesystem-analysis command from a 99%-full disk', async () => {
    await drainBeat();

    const { maybeQueueThresholdFilesystemAnalysis } = await import('./helpers');
    expect(maybeQueueThresholdFilesystemAnalysis).not.toHaveBeenCalled();
  });

  it('resolves no upgrade target, no update policy and no manifest trust material', async () => {
    await drainBeat();

    const { getOrgAgentUpdateConfig, resolvePinnedUpgradeTarget } = await import('./helpers');
    expect(getOrgAgentUpdateConfig).not.toHaveBeenCalled();
    expect(resolvePinnedUpgradeTarget).not.toHaveBeenCalled();
    expect(getActiveTrustKeysetMock).not.toHaveBeenCalled();
    expect(getActiveManifestKeyDelegationsMock).not.toHaveBeenCalled();
  });

  it('builds no policy config (event log, monitoring, PAM, patch source, OneDrive, policy probe, helper)', async () => {
    await drainBeat();

    const helpers = await import('./helpers');
    expect(helpers.buildEventLogConfigUpdate).not.toHaveBeenCalled();
    expect(helpers.buildMonitoringConfigUpdate).not.toHaveBeenCalled();
    expect(helpers.buildPamConfigUpdate).not.toHaveBeenCalled();
    expect(helpers.buildPatchSourceConfigUpdate).not.toHaveBeenCalled();
    expect(helpers.buildOnedriveHelperConfigUpdate).not.toHaveBeenCalled();
    expect(helpers.buildPolicyProbeConfigUpdate).not.toHaveBeenCalled();
    expect(helpers.buildHelperConfigUpdate).not.toHaveBeenCalled();
  });

  it('never reads the devices row at all during a drain beat', async () => {
    await drainBeat();

    expect(selectMock).not.toHaveBeenCalled();
  });

  it('still returns 200 with an empty command list when nothing is queued yet', async () => {
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([]);

    const resp = await drainBeat();

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ commands: [] });
  });

  it('a TENANT drain still gets the full heartbeat (the minimal branch is device-scoped only)', async () => {
    // Guards the branch condition: keying the minimal beat on `tenantDraining`
    // would silently strip config/upgrades from every machine of a customer
    // that is merely offboarding and still paying.
    selectMock.mockReset();
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'linux',
          architecture: 'amd64',
          agentVersion: '0.65.10',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
        },
      ]),
    );
    selectMock.mockReturnValue(selectChainResolving([]));

    const resp = await buildDrainingApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toContain('configUpdate');
    expect(Object.keys(body)).toContain('manifestTrustKeys');
  });
});

// ---------------------------------------------------------------------
// #3207 W5 — scheduled-restart status denormalized from the heartbeat
// ---------------------------------------------------------------------

describe('POST /agents/:id/heartbeat — reboot status (#3207 W5)', () => {
  const SCHEDULED_AT = '2026-09-02T13:00:00.000Z';
  const DEADLINE = '2026-09-02T16:00:00.000Z';

  function arrange(deviceOverrides: Record<string, unknown> = {}) {
    vi.clearAllMocks();
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          siteId: 'site-1',
          hostname: 'host-1',
          osType: 'windows',
          osVersion: 'Microsoft Windows 11 Pro',
          osBuild: null,
          architecture: 'amd64',
          agentVersion: '0.65.10',
          deviceRole: 'workstation',
          deviceRoleSource: 'auto',
          agentTokenHash: 'hash',
          tokenIssuedAt: new Date(),
          // A device with nothing scheduled — the steady state for most of a
          // fleet. Overridden below by the tests that need a live schedule.
          rebootScheduledAt: null,
          rebootDeadline: null,
          rebootSource: null,
          rebootDeferralsUsed: null,
          rebootMaxDeferrals: null,
          ...deviceOverrides,
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    updateMock.mockReturnValue({ set: setSpy });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    selectMock.mockReturnValue(selectChainResolving([]));
    return setSpy;
  }

  async function beat(body: Record<string, unknown>) {
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...minimalHeartbeatBody, ...body }),
    });
  }

  function updateArgOf(setSpy: ReturnType<typeof arrange>) {
    return (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
  }

  const LIVE_SCHEDULE = {
    rebootScheduledAt: new Date(SCHEDULED_AT),
    rebootDeadline: new Date(DEADLINE),
    rebootSource: 'patch_job',
    rebootDeferralsUsed: 1,
    rebootMaxDeferrals: 3,
  };

  it('persists the reboot snapshot the agent reports', async () => {
    const setSpy = arrange();
    const resp = await beat({
      pendingReboot: true,
      rebootStatus: {
        scheduledAt: SCHEDULED_AT,
        deadline: DEADLINE,
        source: 'patch_job',
        deferralsUsed: 1,
        maxDeferrals: 3,
      },
    });

    expect(resp.status).toBe(200);
    const updateArg = updateArgOf(setSpy);
    expect(updateArg.rebootScheduledAt).toEqual(new Date(SCHEDULED_AT));
    expect(updateArg.rebootDeadline).toEqual(new Date(DEADLINE));
    expect(updateArg.rebootSource).toBe('patch_job');
    expect(updateArg.rebootDeferralsUsed).toBe(1);
    expect(updateArg.rebootMaxDeferrals).toBe(3);
  });

  it('persists maxDeferrals=0 so the console can say "cannot be postponed"', async () => {
    // 0 and NULL mean different things: 0 is "this restart has no deferral
    // budget", NULL is "this agent predates deferral reporting". A falsy-guard
    // regression here would collapse the two and the badge would silently stop
    // distinguishing them.
    const setSpy = arrange();
    await beat({
      rebootStatus: {
        scheduledAt: SCHEDULED_AT,
        source: 'maintenance_window',
        deferralsUsed: 0,
        maxDeferrals: 0,
      },
    });

    const updateArg = updateArgOf(setSpy);
    expect(updateArg.rebootDeferralsUsed).toBe(0);
    expect(updateArg.rebootMaxDeferrals).toBe(0);
  });

  it('leaves stored values alone when rebootStatus is absent (old agent)', async () => {
    // Absent must mean "no news", not "cancelled" — otherwise every pre-#3207
    // agent in the fleet wipes the console's view on its next heartbeat.
    const setSpy = arrange(LIVE_SCHEDULE);
    await beat({ pendingReboot: true });

    const updateArg = updateArgOf(setSpy);
    expect(Object.hasOwn(updateArg, 'rebootScheduledAt')).toBe(false);
    expect(Object.hasOwn(updateArg, 'rebootDeadline')).toBe(false);
    expect(Object.hasOwn(updateArg, 'rebootSource')).toBe(false);
    expect(Object.hasOwn(updateArg, 'rebootDeferralsUsed')).toBe(false);
    expect(Object.hasOwn(updateArg, 'rebootMaxDeferrals')).toBe(false);
  });

  it('clears the stored schedule when the agent reports rebootStatus: null', async () => {
    // An explicit null IS news: the restart was cancelled, or it already fired.
    const setSpy = arrange(LIVE_SCHEDULE);
    await beat({ rebootStatus: null });

    const updateArg = updateArgOf(setSpy);
    expect(updateArg.rebootScheduledAt).toBeNull();
    expect(updateArg.rebootDeadline).toBeNull();
    expect(updateArg.rebootSource).toBeNull();
    expect(updateArg.rebootDeferralsUsed).toBeNull();
    expect(updateArg.rebootMaxDeferrals).toBeNull();
  });

  it('does not touch the reboot columns when null is reported and nothing was stored', async () => {
    // The steady state for most of a fleet: no restart scheduled, so the agent
    // reports null on every beat forever. Writing five NULLs over five NULLs on
    // every heartbeat from every device is pure SET-list noise.
    const setSpy = arrange();
    await beat({ rebootStatus: null });

    const updateArg = updateArgOf(setSpy);
    expect(Object.hasOwn(updateArg, 'rebootScheduledAt')).toBe(false);
    expect(Object.hasOwn(updateArg, 'rebootMaxDeferrals')).toBe(false);
    // The rest of the heartbeat still landed.
    expect(updateArg.status).toBe('online');
  });

  it('stores NULLs for the optional members an agent omits', async () => {
    const setSpy = arrange(LIVE_SCHEDULE);
    await beat({ rebootStatus: { scheduledAt: SCHEDULED_AT } });

    const updateArg = updateArgOf(setSpy);
    expect(updateArg.rebootScheduledAt).toEqual(new Date(SCHEDULED_AT));
    expect(updateArg.rebootDeadline).toBeNull();
    expect(updateArg.rebootSource).toBeNull();
    expect(updateArg.rebootDeferralsUsed).toBeNull();
    expect(updateArg.rebootMaxDeferrals).toBeNull();
  });

  // NOTE: the zod-level drops (malformed scheduledAt, out-of-range counters,
  // a source outside ^[a-z0-9_]{1,32}$) are NOT testable from here — this file
  // mocks '@hono/zod-validator' so the handler reads the raw body. They live in
  // schemas.heartbeatTolerance.test.ts, and what reaches this route once a
  // field has been dropped is exactly the "absent" case covered above.
});
