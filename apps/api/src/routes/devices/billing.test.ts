import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { requirePermissionMock, requireScopeMock, coveringMock, siteDenied } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  coveringMock: vi.fn(),
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' }, scope: 'partner', orgId: null,
      accessibleOrgIds: ['org-123'], canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: requireScopeMock,
  requirePermission: requirePermissionMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/deviceCoverage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/deviceCoverage')>();
  return { ...actual, contractLinesCoveringDevice: coveringMock };
});

import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { DeviceCoverageError } from '../../services/deviceCoverage';
import { billingRoutes } from './billing';

const registeredPermissionCalls = [...requirePermissionMock.mock.calls];
const registeredScopeCalls = [...requireScopeMock.mock.calls];

const DEVICE = { id: 'device-1', orgId: 'org-123', siteId: 'site-1' };
const PAYLOAD = {
  deviceId: 'device-1', orgId: 'org-123', deviceRole: 'server', siteId: 'site-1',
  notBillable: false, notBillableReason: null, uncovered: false,
  lines: [{
    contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active', lineId: 'l1',
    lineType: 'per_device_role', description: 'Managed servers', matchedBy: 'role',
    siteId: null, deviceRoles: ['server'], deviceGroup: null,
  }],
};

describe('GET /devices/:id/billing (#3205 W06)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.onError((err, c) => c.json({ unhandled: err.message }, 500));
    app.route('/devices', billingRoutes);
  });

  it('gates on devices:read AND contracts:read — a devices:read-only caller cannot reach it', () => {
    expect(registeredPermissionCalls).toContainEqual(['devices', 'read']);
    expect(registeredPermissionCalls).toContainEqual(['contracts', 'read']);
  });

  it('registers partner+system scopes only — an organization token is refused', () => {
    expect(registeredScopeCalls).toContainEqual(['partner', 'system']);
    expect(registeredScopeCalls.flat()).not.toContain('organization');
  });

  it('site-denied → 403 and no coverage work', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this site denied' });
    expect(coveringMock).not.toHaveBeenCalled();
  });

  it('the chokepoint 404 and the service 404 share ONE body shape', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);
    const fromChokepoint = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(fromChokepoint.status).toBe(404);
    expect(await fromChokepoint.json()).toEqual({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockRejectedValueOnce(new DeviceCoverageError('Device not found', 404, 'DEVICE_NOT_FOUND'));
    const fromService = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(fromService.status).toBe(404);
    expect(await fromService.json()).toEqual({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  });

  it('happy path returns the { data } envelope and passes accessibleOrgIds through', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockResolvedValueOnce(PAYLOAD);
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: PAYLOAD });
    expect(coveringMock).toHaveBeenCalledWith('device-1', { accessibleOrgIds: ['org-123'] });
  });

  it('GROUP_EVALUATION_FAILED → 500 with code + details, and NO lines key', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockRejectedValueOnce(new DeviceCoverageError(
      'Device group "VIP Laptops" could not be evaluated (invalid_filter)', 500, 'GROUP_EVALUATION_FAILED',
      { groupId: 'g1', groupName: 'VIP Laptops', reason: 'invalid_filter' },
    ));
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Device group "VIP Laptops" could not be evaluated (invalid_filter)',
      code: 'GROUP_EVALUATION_FAILED',
      details: { groupId: 'g1', groupName: 'VIP Laptops', reason: 'invalid_filter' },
    });
    expect(body).not.toHaveProperty('lines');
  });

  it('an unrecognised throw propagates instead of being swallowed into a 200', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(DEVICE as never);
    coveringMock.mockRejectedValueOnce(new Error('kaboom'));
    const res = await app.request('/devices/device-1/billing', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ unhandled: 'kaboom' });
  });
});
