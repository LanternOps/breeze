import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------- mocks ----------

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const runOutsideDbContextMock = vi.fn(async (fn: () => unknown) => fn());

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) =>
    runOutsideDbContextMock(...(args as [any])),
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
    agentTokenHash: 'devices.agent_token_hash',
    tokenIssuedAt: 'devices.token_issued_at',
  },
  deviceMetrics: { deviceId: 'device_metrics.device_id' },
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
  getActiveTrustKeyset: (...args: unknown[]) =>
    getActiveTrustKeysetMock(...(args as [])),
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

  it('invokes runOutsideDbContext so the system-scoped read isn\'t suppressed by tenant RLS', async () => {
    getActiveTrustKeysetMock.mockResolvedValue([]);

    await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    // Confirm runOutsideDbContext was used — without it, the inner
    // withSystemDbAccessContext inside getActiveTrustKeyset short-circuits
    // and the manifest_signing_keys read returns zero rows.
    expect(runOutsideDbContextMock).toHaveBeenCalled();
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
