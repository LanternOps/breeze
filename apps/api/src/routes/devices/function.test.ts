import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied } = vi.hoisted(() => ({ siteDenied: Symbol('SITE_ACCESS_DENIED') }));

const middlewareCalls = vi.hoisted(() => ({ permission: [] as Array<[string, string]>, mfa: 0 }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'tech@example.com' },
      scope: 'organization',
      orgId: 'org-123',
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (_c: any, next: any) => {
    middlewareCalls.permission.push([resource, action]);
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => {
    middlewareCalls.mfa += 1;
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/deviceFunction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/deviceFunction')>();
  return {
    DeviceFunctionError: actual.DeviceFunctionError,
    getDeviceFunction: vi.fn(),
    upsertDeviceFunction: vi.fn(),
    clearDeviceFunction: vi.fn(),
  };
});

import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  DeviceFunctionError,
  clearDeviceFunction,
  getDeviceFunction,
  upsertDeviceFunction,
} from '../../services/deviceFunction';
import { functionRoutes } from './function';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const device = { id: DEVICE_ID, orgId: 'org-123', siteId: 'site-1', hostname: 'srv-01', displayName: null };

const NULL_DTO = {
  deviceId: DEVICE_ID, functionKey: null, label: null, source: null, confidence: null,
  evidence: [], assessedAt: null, runId: null, reportRunId: null,
};

function makeApp() {
  const app = new Hono();
  app.route('/devices', functionRoutes);
  return app;
}

function jsonReq(path: string, method: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  middlewareCalls.permission.length = 0;
  middlewareCalls.mfa = 0;
  vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(device as never);
  vi.mocked(getDeviceFunction).mockResolvedValue(NULL_DTO);
});

describe('GET /devices/:id/function', () => {
  it('returns the DTO (nulls when none) under devices:read', async () => {
    const res = await makeApp().request(`/devices/${DEVICE_ID}/function`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NULL_DTO);
    expect(getDeviceFunction).toHaveBeenCalledWith(DEVICE_ID, 'org-123');
    expect(middlewareCalls.permission).toEqual([['devices', 'read']]);
    expect(middlewareCalls.mfa).toBe(0);
  });

  it('404s for a device outside access and 403s for a site the user cannot see', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    expect((await makeApp().request(`/devices/${DEVICE_ID}/function`)).status).toBe(404);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(SITE_ACCESS_DENIED as never);
    expect((await makeApp().request(`/devices/${DEVICE_ID}/function`)).status).toBe(403);
    expect(getDeviceFunction).not.toHaveBeenCalled();
  });
});

describe('PUT /devices/:id/function', () => {
  it('writes a manual assessment, audits device.function.set, and returns the DTO', async () => {
    vi.mocked(upsertDeviceFunction).mockResolvedValue({ outcome: 'written', assessmentId: 'a-1' });
    const dto = { ...NULL_DTO, functionKey: 'file_server', source: 'manual' as const, assessedAt: '2026-09-13T00:00:00.000Z' };
    vi.mocked(getDeviceFunction).mockResolvedValue(dto);

    const res = await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'file_server' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dto);
    expect(upsertDeviceFunction).toHaveBeenCalledWith({
      deviceId: DEVICE_ID, orgId: 'org-123', functionKey: 'file_server', label: undefined,
      source: 'manual', userId: 'user-123',
    });
    expect(clearDeviceFunction).not.toHaveBeenCalled();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-123', action: 'device.function.set', resourceType: 'device', resourceId: DEVICE_ID,
      resourceName: 'srv-01', details: { functionKey: 'file_server', outcome: 'written' },
    }));
    expect(middlewareCalls.permission).toEqual([['devices', 'write']]);
    expect(middlewareCalls.mfa).toBe(1);
  });

  it('clears on functionKey: null', async () => {
    vi.mocked(clearDeviceFunction).mockResolvedValue({ outcome: 'cleared', supersededAssessmentId: 'a-1' });
    const res = await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: null }));
    expect(res.status).toBe(200);
    expect(clearDeviceFunction).toHaveBeenCalledWith({ deviceId: DEVICE_ID, orgId: 'org-123', userId: 'user-123' });
    expect(upsertDeviceFunction).not.toHaveBeenCalled();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.function.set', details: { functionKey: null, outcome: 'cleared' },
    }));
  });

  it('400s a custom key without a label and an unknown key (validator), never touching the service', async () => {
    expect((await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'custom:pos' }))).status).toBe(400);
    expect((await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'nonsense' }))).status).toBe(400);
    expect(upsertDeviceFunction).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('passes a custom key with its label through', async () => {
    vi.mocked(upsertDeviceFunction).mockResolvedValue({ outcome: 'written', assessmentId: 'a-2' });
    const res = await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'custom:pos', label: ' POS ' }));
    expect(res.status).toBe(200);
    expect(upsertDeviceFunction).toHaveBeenCalledWith(expect.objectContaining({ functionKey: 'custom:pos', label: 'POS' }));
  });

  it('maps a DeviceFunctionError to 400 (404 for device_not_found) with its code and does not audit', async () => {
    vi.mocked(upsertDeviceFunction).mockRejectedValueOnce(new DeviceFunctionError('device_not_found'));
    let res = await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'file_server' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'device_not_found' });

    vi.mocked(upsertDeviceFunction).mockRejectedValueOnce(new DeviceFunctionError('label_required'));
    res = await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'file_server' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'label_required' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('404s / 403s before writing when the device is not accessible', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    expect((await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'file_server' }))).status).toBe(404);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(SITE_ACCESS_DENIED as never);
    expect((await makeApp().request(jsonReq(`/devices/${DEVICE_ID}/function`, 'PUT', { functionKey: 'file_server' }))).status).toBe(403);
    expect(upsertDeviceFunction).not.toHaveBeenCalled();
  });
});
