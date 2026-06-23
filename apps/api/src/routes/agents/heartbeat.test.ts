import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AgentUpdateSettings, AgentUpdateDayOfWeek } from './agentUpdatePolicy';

// ---------- mocks ----------

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const runOutsideDbContextMock = vi.fn(async (fn: () => unknown) => fn());

// Records the order of key lifecycle events so a test can assert the
// manifest-trust-keyset fetch happens AFTER the org DB context closes
// (the #1105 pool-poison fix). Reset per test.
const callOrder: string[] = [];

function updateSettings(
  mode: AgentUpdateSettings['mode'],
  timing: AgentUpdateSettings['timing'] = 'asap',
  schedule: AgentUpdateSettings['schedule'] = null,
): AgentUpdateSettings {
  return {
    mode,
    timing: mode === 'manual' ? 'asap' : timing,
    schedule: mode === 'manual' ? null : schedule,
    pins: {},
    legacyPolicy: null,
    legacyMaintenanceWindow: null,
    legacyWindowInvalid: false,
  };
}

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: (...args: unknown[]) => selectMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
      insert: (...args: unknown[]) => insertMock(...(args as [])),
    }),
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
  deviceCommands: {
    id: 'device_commands.id',
    deviceId: 'device_commands.device_id',
    type: 'device_commands.type',
    payload: 'device_commands.payload',
    status: 'device_commands.status',
    targetRole: 'device_commands.target_role',
    result: 'device_commands.result',
    createdAt: 'device_commands.created_at',
    executedAt: 'device_commands.executed_at',
    completedAt: 'device_commands.completed_at',
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
  // Permissive default (staged + no window = upgrade anytime) so the upgrade
  // gating is transparent to tests that don't care about the org policy.
  getOrgAgentUpdatePolicy: vi.fn(async () => ({ policy: 'staged', maintenanceWindow: null })),
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

function selectChainBySelectedFields(args: {
  deviceRow: Record<string, unknown>;
  version: string;
  markerRow?: Record<string, unknown>;
  setAutoUpdateRow?: Record<string, unknown>;
  pendingComponentCommands?: Record<string, unknown>[];
}) {
  selectMock.mockImplementation((fields?: Record<string, unknown>) => {
    if (fields?.id === 'device_commands.id' && Object.keys(fields).length === 1) {
      return selectChainResolving(args.pendingComponentCommands ?? []);
    }
    if (fields?.payload === 'device_commands.payload') {
      return selectChainResolving(args.markerRow ? [args.markerRow] : []);
    }
    if (fields?.type === 'device_commands.type' && fields?.result === 'device_commands.result') {
      return selectChainResolving(args.setAutoUpdateRow ? [args.setAutoUpdateRow] : []);
    }
    if (fields?.version === 'agent_versions.version') {
      return selectChainResolving([{ version: args.version }]);
    }
    return selectChainResolving([args.deviceRow]);
  });
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

  it('Watchdog heartbeat accepts long build-tag versions and stores the full watchdog version', async () => {
    const longWatchdogVersion = 'agent-watchdog-update-b826573971401b7274407fb701a4e5059be17f7e';
    selectMock.mockReturnValueOnce(
      selectChainResolving([
        {
          id: 'device-1',
          orgId: 'org-1',
          hostname: 'TST-LAPTOP-01',
          lastSeenAt: oneMinuteAgo,
          mainAgentSilentSince: null,
        },
      ]),
    );
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    updateMock.mockReturnValue({ set: setSpy });
    selectMock.mockReturnValue(selectChainResolving([]));

    const resp = await buildWatchdogApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentVersion: longWatchdogVersion,
        role: 'watchdog',
        watchdogState: 'MONITORING',
      }),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.watchdogVersion).toBe(longWatchdogVersion);
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

  it('watchdog heartbeat still succeeds when command claiming fails', async () => {
    const { claimPendingCommandsForDevice } = await import('../../services/commandDispatch');
    const { captureException } = await import('../../services/sentry');
    vi.mocked(claimPendingCommandsForDevice).mockRejectedValueOnce(new Error('dispatch unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
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
      const body = await resp.json() as { commands?: unknown[] };
      expect(body.commands).toEqual([]);
      expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
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
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
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

  it('does not return watchdogUpgradeTo on watchdog heartbeats', async () => {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    primeSelects(
      {
        id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows',
        architecture: 'amd64', agentVersion: '0.82.2', watchdogVersion: '0.65.20',
        lastSeenAt: oneMinuteAgo, mainAgentSilentSince: null,
      },
      [{ version: '0.82.3' }],
    );

    const resp = await post();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { watchdogUpgradeTo?: string };
    expect(body.watchdogUpgradeTo).toBeUndefined();
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
        where: vi.fn().mockResolvedValue(undefined),
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

  it('fails open to uacInterceptionEnabled=true when the pam resolver throws', async () => {
    const { buildPamConfigUpdate } = await import('./helpers');
    vi.mocked(buildPamConfigUpdate).mockRejectedValueOnce(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.uacInterceptionEnabled).toBe(true);
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
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
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
    const { compareAgentVersions, getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // latest > reported
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });

  it('manual legacy marker → returns upgradeTo after set_auto_update completes', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));
    const legacyDevice = { ...deviceRow, agentVersion: '0.82.1', watchdogVersion: '0.82.1' };
    selectChainBySelectedFields({
      deviceRow: legacyDevice,
      version: '0.83.0',
      markerRow: {
        id: 'cmd-legacy',
        payload: { version: '0.83.0', setAutoUpdateCommandId: 'cmd-auto' },
        status: 'pending',
      },
      setAutoUpdateRow: {
        id: 'cmd-auto',
        type: 'set_auto_update',
        status: 'completed',
        result: { enabled: true },
      },
    });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.82.1', metrics: minimalHeartbeatBody.metrics }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBe('0.83.0');
  });

  it('manual legacy marker → withholds upgradeTo until set_auto_update completes', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));
    const legacyDevice = { ...deviceRow, agentVersion: '0.82.1', watchdogVersion: '0.82.1' };
    selectChainBySelectedFields({
      deviceRow: legacyDevice,
      version: '0.83.0',
      markerRow: {
        id: 'cmd-legacy',
        payload: { version: '0.83.0', setAutoUpdateCommandId: 'cmd-auto' },
        status: 'pending',
      },
      setAutoUpdateRow: {
        id: 'cmd-auto',
        type: 'set_auto_update',
        status: 'pending',
        result: null,
      },
    });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.82.1', metrics: minimalHeartbeatBody.metrics }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });

  it('manual legacy marker → completes when the agent reports the target version', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));
    const updateSets: Array<Record<string, unknown>> = [];
    const insertValues: Array<Record<string, unknown>> = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSets.push(value);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    insertMock.mockImplementation(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertValues.push(value);
        return Promise.resolve(undefined);
      }),
    }));
    const upgradedDevice = { ...deviceRow, agentVersion: '0.82.1', watchdogVersion: '0.82.1' };
    selectChainBySelectedFields({
      deviceRow: upgradedDevice,
      version: '0.83.0',
      markerRow: {
        id: 'cmd-legacy',
        payload: { version: '0.83.0', setAutoUpdateCommandId: 'cmd-auto' },
        status: 'sent',
      },
    });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.83.0', metrics: minimalHeartbeatBody.metrics }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
    expect(updateSets).toContainEqual(expect.objectContaining({
      status: 'completed',
      result: expect.objectContaining({ updated_to: '0.83.0' }),
    }));
    expect(insertValues).toContainEqual(expect.objectContaining({
      deviceId: 'device-1',
      type: 'set_auto_update',
      status: 'pending',
      targetRole: 'agent',
      createdBy: null,
      payload: expect.objectContaining({
        enabled: false,
        reason: 'legacy_agent_update_complete',
        sourceCommandId: 'cmd-legacy',
        targetVersion: '0.83.0',
      }),
    }));
  });

  it('manual legacy marker → times out and restores org auto_update setting', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));
    const updateSets: Array<Record<string, unknown>> = [];
    const insertValues: Array<Record<string, unknown>> = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSets.push(value);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    insertMock.mockImplementation(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertValues.push(value);
        return Promise.resolve(undefined);
      }),
    }));
    const legacyDevice = { ...deviceRow, agentVersion: '0.82.1', watchdogVersion: '0.82.1' };
    selectChainBySelectedFields({
      deviceRow: legacyDevice,
      version: '0.82.2',
      markerRow: {
        id: 'cmd-legacy',
        payload: { version: '0.82.2', setAutoUpdateCommandId: 'cmd-auto' },
        status: 'sent',
        executedAt: new Date(Date.now() - 31 * 60 * 1000),
      },
    });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.82.1', metrics: minimalHeartbeatBody.metrics }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
    expect(updateSets).toContainEqual(expect.objectContaining({
      status: 'failed',
      result: { error: 'legacy agent update timed out' },
    }));
    expect(insertValues).toContainEqual(expect.objectContaining({
      deviceId: 'device-1',
      type: 'set_auto_update',
      status: 'pending',
      targetRole: 'agent',
      createdBy: null,
      payload: expect.objectContaining({
        enabled: false,
        reason: 'legacy_agent_update_failed',
        sourceCommandId: 'cmd-legacy',
        targetVersion: '0.82.2',
        error: 'legacy agent update timed out',
      }),
    }));
  });

  it('automatic legacy marker → restores auto_update=true after the agent reports the target version', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('automatic', 'asap'));
    const insertValues: Array<Record<string, unknown>> = [];
    updateMock.mockImplementation(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
    insertMock.mockImplementation(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertValues.push(value);
        return Promise.resolve(undefined);
      }),
    }));
    const upgradedDevice = { ...deviceRow, agentVersion: '0.82.1', watchdogVersion: '0.82.1' };
    selectChainBySelectedFields({
      deviceRow: upgradedDevice,
      version: '0.83.0',
      markerRow: {
        id: 'cmd-legacy',
        payload: { version: '0.83.0', setAutoUpdateCommandId: 'cmd-auto' },
        status: 'sent',
      },
    });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'agent', agentVersion: '0.83.0', metrics: minimalHeartbeatBody.metrics }),
    });

    expect(resp.status).toBe(200);
    expect(insertValues).toContainEqual(expect.objectContaining({
      type: 'set_auto_update',
      targetRole: 'agent',
      payload: expect.objectContaining({
        enabled: true,
        reason: 'legacy_agent_update_complete',
        sourceCommandId: 'cmd-legacy',
      }),
    }));
  });

  it('auto policy with no maintenance window → offers agent upgradeTo when newer exists', async () => {
    const { compareAgentVersions, getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('automatic', 'asap'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBe('0.66.0');
  });

  it('staged policy outside the maintenance window → withholds agent upgradeTo', async () => {
    const { compareAgentVersions, getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    // A window on a different UTC day than "now" guarantees we're outside it.
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const otherDay = days[(new Date().getUTCDay() + 3) % 7]!;
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('automatic', 'weekly', {
      windows: [{
        dayOfWeek: otherDay.toLowerCase() as AgentUpdateDayOfWeek,
        start: '02:00',
        end: '04:00',
      }],
    }));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });

  it('fails closed (withholds upgrade) when the policy lookup throws', async () => {
    const { compareAgentVersions, getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdatePolicy).mockRejectedValueOnce(new Error('db down'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceRow]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    const resp = await postAgentHeartbeat();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { upgradeTo?: string | null };
    expect(body.upgradeTo).toBeFalsy();
  });

  // A dev-push build (dev-*) must never be auto-upgraded back to a release,
  // regardless of policy. This pins the precedence of the dev-build short
  // circuit relative to the `updateGateAllows` branch (heartbeat.ts:508-511).
  it('dev- agent build is never upgraded even under auto policy', async () => {
    const { compareAgentVersions, getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('automatic', 'asap'));
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
    architecture: 'amd64', agentVersion: '0.83.0', watchdogVersion: '0.65.0',
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
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    });
    insertMock.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  });

  // Reports an installed helperVersion so the helper path takes the gated
  // version-to-version branch (not the ungated `!data.helperVersion` bootstrap).
  async function postWithInstalledComponents(deviceRow: typeof deviceWithWatchdog) {
    const { compareAgentVersions } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1); // latest > reported, all components
    selectChainBySelectedFields({ deviceRow, version: '0.66.0' });
    return buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'agent', agentVersion: deviceRow.agentVersion, helperVersion: '0.65.0',
        metrics: minimalHeartbeatBody.metrics,
      }),
    });
  }

  it('manual policy → withholds helper and watchdog version-to-version upgrades', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));

    const resp = await postWithInstalledComponents(deviceWithWatchdog);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null };
    expect(body.helperUpgradeTo).toBeFalsy();
    expect(body.watchdogUpgradeTo).toBeFalsy();
  });

  it('auto policy → offers helper upgrade and queues watchdog update through the agent command path', async () => {
    const { getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('automatic', 'asap'));
    const valuesMock = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesMock });

    const resp = await postWithInstalledComponents(deviceWithWatchdog);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { helperUpgradeTo?: string | null; watchdogUpgradeTo?: string | null };
    expect(body.helperUpgradeTo).toBe('0.66.0');
    expect(body.watchdogUpgradeTo).toBeFalsy();

    const queuedWatchdogCommand = valuesMock.mock.calls
      .map(([row]) => row as Record<string, unknown>)
      .find((row) => row.type === 'update_watchdog');
    expect(queuedWatchdogCommand).toMatchObject({
      deviceId: 'device-1',
      type: 'update_watchdog',
      status: 'pending',
      targetRole: 'agent',
      createdBy: null,
    });
    expect(queuedWatchdogCommand?.payload).toMatchObject({
      component: 'watchdog',
      version: '0.66.0',
      manual: false,
      automatic: true,
      source: 'policy-autoheal',
      reason: 'outdated',
    });
  });

  it('manual policy → bootstraps missing helper but withholds automatic watchdog repair', async () => {
    const { compareAgentVersions, getOrgAgentUpdatePolicy } = await import('./helpers');
    vi.mocked(compareAgentVersions).mockReturnValue(1);
    vi.mocked(getOrgAgentUpdatePolicy).mockResolvedValue(updateSettings('manual'));
    selectMock.mockReturnValueOnce(selectChainResolving([deviceNeedingBootstrap]));
    selectMock.mockReturnValue(selectChainResolving([{ version: '0.66.0' }]));

    // No helperVersion in the body → helper bootstrap branch. watchdogVersion
    // null on the device → watchdog repair branch, now gated by manual mode.
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
    expect(body.helperUpgradeTo).toBe('0.66.0'); // helper bootstrap remains unchanged
    expect(body.watchdogUpgradeTo).toBeFalsy(); // watchdog autoheal is manual-gated
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
    const setSpy = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
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
