import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn() },
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
      if (
        c.req.header('x-deny-devices-execute') === 'true' &&
        resource === 'devices' &&
        action === 'execute'
      ) {
        return c.json({ error: 'Permission denied' }, 403);
      }
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true'
          ? { allowedSiteIds: ['site-allowed'] }
          : {}),
      });
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

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: vi.fn(),
}));

const queueCommandForExecutionMock = vi.fn();

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { HOMEBREW_BOOTSTRAP: 'homebrew_bootstrap' },
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...args),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandAudit', () => ({
  commandAuditDetails: vi.fn((id: string, type: string) => ({ commandId: id, commandType: type })),
}));

import { homebrewBootstrapRoutes } from './homebrewBootstrap';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  HOMEBREW_INSTALLER_SHA256,
  HOMEBREW_INSTALLER_URL,
} from '../../services/homebrewBootstrap';

const macDevice = {
  id: 'device-1',
  orgId: 'org-123',
  siteId: null,
  hostname: 'mac-1',
  status: 'online',
  osType: 'macos',
};

describe('POST /devices/:id/homebrew-bootstrap', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    queueCommandForExecutionMock.mockReset();
    app = new Hono();
    app.route('/devices', homebrewBootstrapRoutes);
  });

  const post = (headers: Record<string, string> = {}) =>
    app.request('/devices/device-1/homebrew-bootstrap', { method: 'POST', headers });

  it('queues homebrew_bootstrap with the pinned installer url + sha256', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(macDevice);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1', status: 'sent' } });

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      commandId: 'cmd-1',
      action: 'homebrew_bootstrap',
      installerUrl: HOMEBREW_INSTALLER_URL,
    });
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      'device-1',
      'homebrew_bootstrap',
      { installerUrl: HOMEBREW_INSTALLER_URL, installerSha256: HOMEBREW_INSTALLER_SHA256 },
      { userId: 'user-123', preferHeartbeat: false }
    );
  });

  it('writes a device.homebrew_bootstrap audit event', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(macDevice);
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1', status: 'sent' } });

    await post();

    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-123',
        action: 'device.homebrew_bootstrap',
        resourceType: 'device',
        resourceId: 'device-1',
        details: expect.objectContaining({
          installerUrl: HOMEBREW_INSTALLER_URL,
          installerSha256: HOMEBREW_INSTALLER_SHA256,
        }),
      })
    );
  });

  it('rejects a non-macOS device with 400 and never queues a command', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...macDevice,
      osType: 'windows',
    });

    const res = await post();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/macOS-only/);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('404s when the device is out of scope', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await post();

    expect(res.status).toBe(404);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('403s when the user lacks devices:execute', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(macDevice);

    const res = await post({ 'x-deny-devices-execute': 'true' });

    expect(res.status).toBe(403);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('403s without MFA', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(macDevice);

    const res = await post({ 'x-deny-mfa': 'true' });

    expect(res.status).toBe(403);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('403s when the device is in a site the user cannot access', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...macDevice,
      siteId: 'site-other',
    });

    const res = await post({ 'x-site-restricted': 'true' });

    expect(res.status).toBe(403);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('400s for a decommissioned device', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...macDevice,
      status: 'decommissioned',
    });

    const res = await post();

    expect(res.status).toBe(400);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('503s when the command could not be queued', async () => {
    (getDeviceWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(macDevice);
    queueCommandForExecutionMock.mockResolvedValue({ command: null, error: 'agent offline' });

    const res = await post();

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('agent offline');
  });
});
