import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const pendingRows = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; type: string }>,
  where: [] as unknown[],
}));

// The real schema (not a mock) so the in-flight filter can be rendered to SQL
// and asserted on: a mocked select that ignores its WHERE would pass even if
// the filter blocked restarts behind any unrelated pending command.
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (cond: unknown) => {
          pendingRows.where.push(cond);
          return { limit: () => Promise.resolve(pendingRows.rows) };
        },
      }),
    })),
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
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(
    (resource: string, action: string) => async (c: any, next: any) => {
      const denied = (c.req.header('x-deny') ?? '').split(',');
      if (denied.includes(`${resource}:${action}`)) {
        return c.json({ error: 'Permission denied' }, 403);
      }
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true' ? { allowedSiteIds: ['site-allowed'] } : {}),
      });
      return next();
    }
  ),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (c.req.header('x-deny-mfa') === 'true') return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: vi.fn(),
}));

const enqueueWatchdogCommandMock = vi.fn();

vi.mock('../../services/commandQueue', () => ({
  enqueueWatchdogCommand: (...args: unknown[]) => enqueueWatchdogCommandMock(...args),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

import { agentRecoveryRoutes } from './agentRecovery';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { requirePermission } from '../../middleware/auth';

// Gates are built when the route module loads; capture them before
// beforeEach's clearAllMocks wipes the call log.
const permissionGates = vi.mocked(requirePermission).mock.calls.map(([r, a]) => `${r}:${a}`);

const watchdogSeen = new Date('2026-10-20T12:00:00.000Z');
const silentDevice = {
  id: 'device-1',
  orgId: 'org-123',
  siteId: null,
  hostname: 'ws-01',
  status: 'offline',
  osType: 'windows',
  watchdogStatus: 'failover',
  watchdogLastSeen: watchdogSeen,
  mainAgentSilentSince: new Date('2026-10-20T11:30:00.000Z'),
};

describe('POST /devices/:id/agent-recovery', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    pendingRows.rows = [];
    pendingRows.where = [];
    enqueueWatchdogCommandMock.mockReset();
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(silentDevice);
    enqueueWatchdogCommandMock.mockResolvedValue({ status: 'queued', commandId: 'cmd-1' });
    app = new Hono();
    app.route('/devices', agentRecoveryRoutes);
  });

  const post = (body: unknown = { action: 'restart_agent' }, headers: Record<string, string> = {}) =>
    app.request('/devices/device-1/agent-recovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('gates on its own devices:recover_agent permission, not devices:execute', async () => {
    expect(permissionGates).toEqual(['devices:recover_agent']);

    const res = await post(undefined, { 'x-deny': 'devices:recover_agent' });

    expect(res.status).toBe(403);
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('queues restart_agent to the watchdog, bound to the device org, and answers 202', async () => {
    const res = await post();

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      commandId: 'cmd-1',
      action: 'restart_agent',
      status: 'queued',
      watchdogStatus: 'failover',
      watchdogLastSeen: watchdogSeen.toISOString(),
    });
    expect(enqueueWatchdogCommandMock).toHaveBeenCalledWith('device-1', 'restart_agent', {
      userId: 'user-123',
      expectedOrgId: 'org-123',
    });
  });

  it('queues start_agent the same way', async () => {
    const res = await post({ action: 'start_agent' });

    expect(res.status).toBe(202);
    expect(enqueueWatchdogCommandMock).toHaveBeenCalledWith('device-1', 'start_agent', expect.anything());
  });

  it('writes its own device.agent_recovery.request audit event', async () => {
    await post();

    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-123',
        action: 'device.agent_recovery.request',
        resourceType: 'device',
        resourceId: 'device-1',
        resourceName: 'ws-01',
        details: expect.objectContaining({
          deviceId: 'device-1',
          commandId: 'cmd-1',
          commandType: 'restart_agent',
          targetRole: 'watchdog',
          watchdogStatus: 'failover',
        }),
      })
    );
  });

  it.each([
    ['update_agent', { action: 'update_agent' }],
    ['an unknown action', { action: 'reboot' }],
    ['a missing action', {}],
  ])('rejects %s with 400 and queues nothing', async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
  });

  it('403s without MFA', async () => {
    const res = await post(undefined, { 'x-deny-mfa': 'true' });

    expect(res.status).toBe(403);
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
  });

  it('404s when the device is out of scope', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await post();

    expect(res.status).toBe(404);
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
  });

  it('403s when the device is in a site the user cannot access', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ ...silentDevice, siteId: 'site-other' });

    const res = await post(undefined, { 'x-site-restricted': 'true' });

    expect(res.status).toBe(403);
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
  });

  it('400s for a decommissioned device', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ ...silentDevice, status: 'decommissioned' });

    const res = await post();

    expect(res.status).toBe(400);
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
  });

  it('looks for in-flight work only among this device\'s watchdog recovery rows', async () => {
    await post();

    expect(pendingRows.where).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(pendingRows.where[0] as SQL);
    expect(sql).toMatch(/"device_id" = \$\d/);
    expect(sql).toMatch(/"target_role" = \$\d/);
    expect(sql).toMatch(/"type" in \(\$\d, \$\d\)/);
    expect(sql).toMatch(/"status" in \(\$\d, \$\d\)/);
    expect(params).toEqual(['device-1', 'watchdog', 'restart_agent', 'start_agent', 'pending', 'sent']);
  });

  it('409s while a watchdog recovery command is already pending for the device', async () => {
    pendingRows.rows = [{ id: 'cmd-old', type: 'restart_agent' }];

    const res = await post();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ALREADY_PENDING', commandId: 'cmd-old' });
    expect(enqueueWatchdogCommandMock).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('409s with the refusal when the watchdog is not reporting, and writes no audit row', async () => {
    enqueueWatchdogCommandMock.mockResolvedValue({
      status: 'failed',
      reason: 'refused',
      error: 'Watchdog is not reporting; cannot dispatch watchdog command',
    });

    const res = await post();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'WATCHDOG_REFUSED',
      error: expect.stringMatching(/watchdog is not reporting/i),
    });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('403s with the trust body when partner trust refuses the command', async () => {
    enqueueWatchdogCommandMock.mockResolvedValue({
      status: 'failed',
      reason: 'trust_denied',
      error: 'TRUST_PROBATION',
      trust: { capability: 'device_execute', reason: 'probation_default_deny' },
    });

    const res = await post({ action: 'start_agent' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'TRUST_PROBATION', capability: 'device_execute' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('404s when the dispatch precheck no longer finds the device in this org', async () => {
    enqueueWatchdogCommandMock.mockResolvedValue({ status: 'failed', reason: 'not_found', error: 'Device not found' });

    const res = await post();

    expect(res.status).toBe(404);
  });

  it('500s (not 409) when the row could not be inserted, and writes no audit row', async () => {
    enqueueWatchdogCommandMock.mockResolvedValue({
      status: 'failed',
      reason: 'insert_failed',
      error: 'Failed to create command',
    });

    const res = await post();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'ENQUEUE_FAILED' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
