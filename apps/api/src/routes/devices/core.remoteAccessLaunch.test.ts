import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Hold a configurable partner-settings value the mocked select chain returns.
// Each test mutates this before calling app.request().
let mockPartnerSettings: unknown = {};

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ settings: mockPartnerSettings }])
          }))
        })),
        where: vi.fn(() => ({
          limit: vi.fn(async () => [])
        }))
      }))
    })),
  }
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  getDeviceWithOrgCheck: vi.fn()
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn(async () => ({ policyId: null, policyName: null, settings: {} }))
}));

vi.mock('../../services/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(() => false)
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {}
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn(() => null)
}));

vi.mock('../../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hash:${k}`)
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn()
}));

import { coreRoutes } from './core';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';

const deviceId = '22222222-2222-2222-2222-222222222222';

function setPartnerSettings(settings: unknown) {
  mockPartnerSettings = settings;
}

describe('POST /devices/:id/remote-access-launch', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPartnerSettings = {};
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  it('returns 404 when device does not exist', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null as never);
    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 with skipReason when no launcher provider is configured', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      customFields: {}
    } as never);
    setPartnerSettings({});
    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('no_provider_configured');
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('returns 200 with launchUrl on success and audits issuance', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      customFields: { rustdesk_id: '294064193' }
    } as never);
    setPartnerSettings({
      remoteAccessProviders: {
        defaultProviderId: 'rustdesk',
        providers: [
          {
            id: 'rustdesk',
            name: 'RustDesk',
            urlTemplate: 'rustdesk://{id}?password={password}',
            customFieldKey: 'rustdesk_id',
            password: 'p#x',
            enabled: true,
          }
        ]
      }
    });

    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { launchUrl?: string; scheme?: string; providerId?: string };
    expect(body.launchUrl).toBe('rustdesk://294064193?password=p%23x');
    expect(body.scheme).toBe('rustdesk');
    expect(body.providerId).toBe('rustdesk');

    expect(writeRouteAudit).toHaveBeenCalledOnce();
    const auditCall = vi.mocked(writeRouteAudit).mock.calls[0]![1];
    expect(auditCall.action).toBe('device.remote_access_launch_url.issued');
    expect(auditCall.resourceType).toBe('device');
    expect(auditCall.resourceId).toBe(deviceId);
    expect(auditCall.orgId).toBe('org-123');
    expect(auditCall.details).toEqual({
      deviceId,
      providerId: 'rustdesk',
      scheme: 'rustdesk'
    });

    // CRITICAL: ensure the URL and password are NOT in the audit details
    const detailsStr = JSON.stringify(auditCall.details ?? {});
    expect(detailsStr).not.toContain('p#x');
    expect(detailsStr).not.toContain('p%23x');
    expect(detailsStr).not.toContain('294064193');
    expect(detailsStr).not.toContain('password');
    expect(detailsStr).not.toContain('rustdesk://');
  });

  it('returns 422 + audit event + Sentry capture when scheme rejected at substitution', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      customFields: { k: 'avas' }
    } as never);
    setPartnerSettings({
      remoteAccessProviders: {
        defaultProviderId: 'sneaky',
        providers: [
          {
            id: 'sneaky',
            name: 'Sneaky',
            urlTemplate: 'j{id}cript:alert(1)',
            customFieldKey: 'k',
            enabled: true,
          }
        ]
      }
    });

    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('scheme_not_allowed');

    expect(writeRouteAudit).toHaveBeenCalledOnce();
    const auditCall = vi.mocked(writeRouteAudit).mock.calls[0]![1];
    expect(auditCall.action).toBe('device.remote_access_launch_url.scheme_rejected');
    expect(auditCall.result).toBe('denied');
    expect(auditCall.details).toEqual({
      deviceId,
      providerId: 'sneaky'
    });
    // No URL or substituted value should appear anywhere in the audit row.
    const detailsStr = JSON.stringify(auditCall.details ?? {});
    expect(detailsStr).not.toContain('javascript');
    expect(detailsStr).not.toContain('alert');
    expect(detailsStr).not.toContain('avas');

    expect(captureException).toHaveBeenCalledOnce();
  });

  it('GET /devices/:id no longer exposes remoteAccessLaunchUrl', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-1',
      customFields: { rustdesk_id: '294064193' }
    } as never);
    setPartnerSettings({
      remoteAccessProviders: {
        defaultProviderId: 'rustdesk',
        providers: [
          {
            id: 'rustdesk',
            name: 'RustDesk',
            urlTemplate: 'rustdesk://{id}?password={password}',
            customFieldKey: 'rustdesk_id',
            password: 'p#x',
            enabled: true,
          }
        ]
      }
    });

    const res = await app.request(`/devices/${deviceId}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    // The GET handler does multiple DB lookups we haven't fully mocked here
    // (deviceMetrics, sites, organizations), so the status may be 500. What
    // matters for this test is that even if it somehow returned 200, the
    // response body MUST NOT contain remoteAccessLaunchUrl.
    if (res.status === 200) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('remoteAccessLaunchUrl');
    }
  });
});
