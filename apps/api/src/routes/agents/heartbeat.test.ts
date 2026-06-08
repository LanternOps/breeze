import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------- mocks ----------

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const runOutsideDbContextMock = vi.fn(async (fn: () => unknown) => fn());

// Records the order of key lifecycle events so a test can assert the
// manifest-trust-keyset fetch happens AFTER the org DB context closes
// (the #1105 pool-poison fix). Reset per test.
const callOrder: string[] = [];

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) =>
    runOutsideDbContextMock(...(args as [any])),
  // Pass-through that records when the scoped callback resolves — in
  // production the org transaction is released at this point.
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => {
    const result = await fn();
    callOrder.push('dbContext:released');
    return result;
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
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
  agentLogs: { deviceId: 'agent_logs.device_id' },
  agentVersions: {
    platform: 'agent_versions.platform',
    architecture: 'agent_versions.architecture',
    component: 'agent_versions.component',
    isLatest: 'agent_versions.is_latest',
    version: 'agent_versions.version',
    createdAt: 'agent_versions.created_at',
  },
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
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/deviceIpHistory', () => ({
  processDeviceIPHistoryUpdate: vi.fn(),
}));

vi.mock('../../services/commandDispatch', () => ({
  claimPendingCommandsForDevice: vi.fn(async () => []),
}));

vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn(async () => undefined),
}));

vi.mock('../../middleware/agentAuth', () => ({
  isAgentTokenRotationDue: vi.fn(() => false),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn(async () => ({
    helperEnabled: false,
    helperSettings: null,
    manageRemoteManagement: false,
  })),
}));

const getActiveTrustKeysetMock = vi.fn();

vi.mock('../../services/manifestSigning', () => ({
  getActiveTrustKeyset: (...args: unknown[]) => {
    callOrder.push('trustKeyset:fetched');
    return getActiveTrustKeysetMock(...(args as []));
  },
}));

import { heartbeatRoutes } from './heartbeat';

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

describe('POST /agents/:id/heartbeat — manifestTrustKeys delivery (#639)', () => {
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

    // db.update for devices → no return needed
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
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

    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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

describe('POST /agents/:id/heartbeat — watchdog restart-stats logging (#799)', () => {
  // Track the values passed to the most recent agentLogs insert.
  let capturedInsertTable: unknown;
  let capturedInsertValues: unknown;

  beforeEach(() => {
    vi.clearAllMocks();

    // Device lookup → returns a row with watchdog columns.
    selectMock.mockReturnValueOnce(
      selectChainResolving([watchdogDeviceRow]),
    );

    // db.update for devices (watchdog status update) → no return needed.
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
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
});
