import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Wiring regression: DELETE /devices/:id (decommission) must tear down any
// live remote-control session to the device being offboarded. The device
// `status` flip alone is only checked at session connect time, so an in-flight
// desktop/terminal session would otherwise survive. PR #1283 added the call;
// this test pins it so a future refactor can't silently drop it (the service
// internals are covered separately by remoteSessionTeardown.test.ts).
//
// Mocks mirror cascadeDelete.test.ts / core.permissions.test.ts. The handler
// runs the REAL getDeviceWithOrgAndSiteCheck chokepoint (which issues its own
// db.select lookup), so we rig db.select to return the fixture device.
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      orgCondition: () => undefined,
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // No allowedSiteIds → the real getDeviceWithOrgAndSiteCheck site gate is a
  // no-op, so the decommission handler body runs.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));

vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));

vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
  disconnectAgent: vi.fn().mockReturnValue('closed'),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

// The unit under test: core.ts imports BOTH terminateDeviceRemoteSessions and
// TEARDOWN_FAILED. The mock MUST export both or the named import resolves to
// undefined and the audit branch (teardownResult === TEARDOWN_FAILED) breaks.
vi.mock('../../services/remoteSessionTeardown', () => ({
  terminateDeviceRemoteSessions: vi.fn().mockResolvedValue(0),
  TEARDOWN_FAILED: -1,
}));

import { coreRoutes } from './core';
import { db } from '../../db';
import { terminateDeviceRemoteSessions } from '../../services/remoteSessionTeardown';
import { disconnectAgent } from '../agentWs';
import { writeRouteAudit } from '../../services/auditEvents';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const ONLINE_DEVICE = {
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: 'Host 1',
  agentId: null,
  status: 'online' as const,
};

describe('DELETE /devices/:id (decommission) — remote-session teardown wiring', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  // getDeviceWithOrgAndSiteCheck issues db.select().from(devices).where(...)
  // .limit(1); then the decommission handler runs db.update().set().where()
  // .returning() → the updated row.
  function rigDecommission(device: unknown) {
    const limit = vi.fn().mockResolvedValue(device ? [device] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const returning = vi.fn().mockResolvedValue([
      { ...(device as object), status: 'decommissioned' },
    ]);
    const updWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updWhere });
    vi.mocked(db.update).mockReturnValue({ set } as never);
  }

  it('calls terminateDeviceRemoteSessions with the decommissioned device id', async () => {
    rigDecommission(ONLINE_DEVICE);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Wiring under test: live remote control to the offboarded device is cut.
    expect(terminateDeviceRemoteSessions).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('does not tear down when the device is already decommissioned (400)', async () => {
    rigDecommission({ ...ONLINE_DEVICE, status: 'decommissioned' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(400);
    expect(terminateDeviceRemoteSessions).not.toHaveBeenCalled();
    expect(disconnectAgent).not.toHaveBeenCalled();
  });

  // Regression coverage for #2230 — see the updateDeviceStatus() doc comment
  // in routes/agentWs.ts for the full incident writeup. The endpoint must
  // force-close the agent's live WS control channel; the handshake gate then
  // rejects the reconnect, and the outcome lands in the audit trail.
  it('force-closes the agent WS control channel and audits the outcome', async () => {
    rigDecommission({ ...ONLINE_DEVICE, agentId: 'agent-abc-123' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(disconnectAgent).toHaveBeenCalledWith('agent-abc-123', 4041, 'Device decommissioned');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.decommission',
      details: expect.objectContaining({ agentWsDisconnect: 'closed' }),
    }));
  });

  it('audits a close failure instead of collapsing it into success', async () => {
    rigDecommission({ ...ONLINE_DEVICE, agentId: 'agent-abc-123' });
    vi.mocked(disconnectAgent).mockReturnValueOnce('close-failed');

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ agentWsDisconnect: 'close-failed' }),
    }));
  });

  it('skips the WS disconnect when the device has no agentId', async () => {
    rigDecommission(ONLINE_DEVICE);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(disconnectAgent).not.toHaveBeenCalled();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ agentWsDisconnect: 'not-connected' }),
    }));
  });
});
