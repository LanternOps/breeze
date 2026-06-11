import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  deviceCommands: { id: 'id', deviceId: 'deviceId', type: 'type', status: 'status' },
  devices: { id: 'id' },
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
      if (c.req.header('x-deny-devices-execute') === 'true' && resource === 'devices' && action === 'execute') {
        return c.json({ error: 'Permission denied' }, 403);
      }
      if (c.req.header('x-site-restricted') === 'true') {
        c.set('permissions', {
          permissions: [{ resource, action }],
          partnerId: null,
          orgId: 'org-123',
          roleId: 'role-123',
          scope: 'organization',
          allowedSiteIds: ['site-allowed'],
        });
      }
      return next();
    }
  ),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (c.req.header('x-deny-mfa') === 'true') {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
}));

const queueCommandForExecutionMock = vi.fn();

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {
    SOFTWARE_UPDATE: 'software_update',
    SOFTWARE_UNINSTALL: 'software_uninstall',
  },
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...args),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandAudit', () => ({
  commandAuditDetails: vi.fn((id: string, type: string) => ({ commandId: id, commandType: type })),
}));

import { softwareActionsRoutes } from './softwareActions';
import { getDeviceWithOrgCheck } from './helpers';

describe('device software actions routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    queueCommandForExecutionMock.mockReset();
    app = new Hono();
    app.route('/devices', softwareActionsRoutes);
  });

  describe('POST /devices/:id/software/update', () => {
    it('queues a software_update command for a valid device + payload', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-1', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Google Chrome' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        commandId: 'cmd-1',
        commandStatus: 'sent',
        action: 'update',
        name: 'Google Chrome',
      });
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Google Chrome', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('passes version through to the agent payload on a Windows device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'windows',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-2', status: 'pending' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Google Chrome', version: '125.0.6422.142' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Google Chrome', version: '125.0.6422.142', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('passes a winget packageId through to the agent payload on Windows', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'windows',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-pkg', status: 'pending' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mozilla Firefox', packageId: 'Mozilla.Firefox' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Mozilla Firefox', packageId: 'Mozilla.Firefox', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('does not forward packageId on a non-Windows device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'macos',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-pkg2', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mozilla Firefox', packageId: 'Mozilla.Firefox' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Mozilla Firefox', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('rejects a malformed packageId before queueing', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Firefox', packageId: 'Mozilla.Firefox;rm -rf /' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it.each(['macos', 'linux'])(
      'rejects a version pin with 422 on a %s device (agent ignores it)',
      async (osType) => {
        (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'device-1',
          orgId: 'org-123',
          siteId: null,
          hostname: 'host-1',
          status: 'online',
          osType,
        });

        const res = await app.request('/devices/device-1/software/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Google Chrome', version: '125.0.6422.142' }),
        });

        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error).toContain(osType);
        expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
      }
    );

    it('allows a version-less update on a non-Windows device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
        osType: 'macos',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-3', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Google Chrome' }),
      });

      expect(res.status).toBe(200);
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_update',
        { name: 'Google Chrome', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('returns 404 when the device cannot be found by org', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.request('/devices/missing/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(404);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('returns 400 for decommissioned devices', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'decommissioned',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('rejects payload with shell metacharacters in name', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome;rm -rf /' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('rejects payload with leading dash in name', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '-rf /' }),
      });

      expect(res.status).toBe(400);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('returns 403 when MFA gate denies the request', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deny-mfa': 'true' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(403);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });

    it('returns 503 when the command could not be queued', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        error: 'Device is offline, cannot execute command',
      });

      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('offline');
    });

    it('returns 403 when permission check denies devices.execute', async () => {
      const res = await app.request('/devices/device-1/software/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deny-devices-execute': 'true' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(403);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /devices/:id/software/uninstall', () => {
    it('queues a software_uninstall command for a valid device + payload', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: null,
        hostname: 'host-1',
        status: 'online',
      });
      queueCommandForExecutionMock.mockResolvedValue({
        command: { id: 'cmd-3', status: 'sent' },
      });

      const res = await app.request('/devices/device-1/software/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        commandId: 'cmd-3',
        action: 'uninstall',
        name: 'Slack',
      });
      expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
        'device-1',
        'software_uninstall',
        { name: 'Slack', source: 'device_software_tab' },
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('returns 403 when site permission denies the device', async () => {
      (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'device-1',
        orgId: 'org-123',
        siteId: 'site-other',
        hostname: 'host-1',
        status: 'online',
      });

      const res = await app.request('/devices/device-1/software/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-site-restricted': 'true' },
        body: JSON.stringify({ name: 'Slack' }),
      });

      expect(res.status).toBe(403);
      expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    });
  });
});
