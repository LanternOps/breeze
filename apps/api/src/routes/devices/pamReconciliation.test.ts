import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  getDevice: vi.fn(), owned: vi.fn(), active: vi.fn(), insert: vi.fn(), audit: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
    select: () => ({ from: (table: { id: string }) => ({ where: () =>
      table.id === 'devices.id' ? { for: mocks.owned } : { limit: mocks.active },
    }) }),
  }) },
}));
vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', status: 'devices.status', osType: 'devices.osType' },
  pamActuations: { id: 'actuations.id', deviceId: 'actuations.deviceId', orgId: 'actuations.orgId', desiredState: 'actuations.desiredState' },
}));
vi.mock('drizzle-orm', () => ({ and: (...values: unknown[]) => values, eq: (a: unknown, b: unknown) => [a, b] }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-no-auth')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: '11111111-1111-4111-8111-111111111111' }, scope: 'organization', orgId: ORG_ID });
    return next();
  },
  requireScope: () => async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-wrong-scope')) return c.json({ error: 'Forbidden' }, 403);
    return next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-deny') === `${resource}:${action}`) return c.json({ error: 'Permission denied' }, 403);
    c.set('permissions', { permissions: [], orgId: ORG_ID, allowedSiteIds: c.req.header('x-site-restricted') ? ['allowed-site'] : undefined });
    return next();
  },
  requireMfa: () => async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-no-mfa')) return c.json({ error: 'MFA required' }, 403);
    return next();
  },
}));
vi.mock('./helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('./helpers')>(), getDeviceWithOrgCheck: mocks.getDevice,
}));
vi.mock('../../services/commandQueueInsert', () => ({ insertQueuedCommandInTransaction: mocks.insert }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));

import { pamReconciliationRoutes } from './pamReconciliation';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const device = { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'test-device', osType: 'windows', status: 'online' };
const app = new Hono().route('/devices', pamReconciliationRoutes);
function post(body: unknown = { reason: 'Retry verified cleanup' }, headers: Record<string, string> = {}, id = DEVICE_ID) {
  return app.request(`/devices/${id}/pam-reconciliation/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDevice.mockResolvedValue(device);
  mocks.owned.mockResolvedValue([device]);
  mocks.active.mockResolvedValue([]);
  mocks.insert.mockResolvedValue({ id: 'command-1', status: 'pending' });
});

describe('POST /devices/:id/pam-reconciliation/reset', () => {
  it('queues a tenant-bound evidence-preserving reset and audits the reason', async () => {
    const response = await post({ reason: '  Retry verified cleanup  ' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true, commandId: 'command-1', commandStatus: 'pending' });
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      deviceId: DEVICE_ID, type: 'pam_reconcile_v2', createdBy: '11111111-1111-4111-8111-111111111111',
      payload: { protocolVersion: 1, deviceId: DEVICE_ID, orgId: ORG_ID },
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, details: { reason: 'Retry verified cleanup', commandId: 'command-1' },
    }));
  });

  it.each([
    ['x-no-auth', 'true', 401], ['x-wrong-scope', 'true', 403], ['x-no-mfa', 'true', 403],
    ['x-deny', 'devices:execute', 403], ['x-deny', 'pam:approve', 403],
  ])('enforces %s=%s', async (header, value, status) => {
    expect((await post(undefined, { [header]: value })).status).toBe(status);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([{}, { reason: '' }, { reason: '   ' }, { reason: 1 }, { reason: 'x'.repeat(2001) }, { reason: 'ok', force: true }])('rejects invalid reset input %j', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rejects an invalid device id', async () => {
    expect((await post(undefined, {}, 'invalid')).status).toBe(400);
    expect(mocks.getDevice).not.toHaveBeenCalled();
  });

  it('does not queue cross-org or missing devices', async () => {
    mocks.getDevice.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('does not queue a device moved to another org during the request', async () => {
    mocks.owned.mockResolvedValue([]);
    expect((await post()).status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each(['initial', 'current'])('checks the %s device site', async (which) => {
    (which === 'initial' ? mocks.getDevice : mocks.owned).mockResolvedValue(which === 'initial'
      ? { ...device, siteId: 'forbidden-site' } : [{ ...device, siteId: 'forbidden-site' }]);
    expect((await post(undefined, { 'x-site-restricted': 'true' })).status).toBe(403);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([{ ...device, osType: 'linux' }, { ...device, status: 'decommissioned' }])('refuses unsupported devices', async (row) => {
    mocks.getDevice.mockResolvedValue(row);
    expect((await post()).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('requires active grants to be revoked first', async () => {
    mocks.active.mockResolvedValue([{ id: 'active-actuation' }]);
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Revoke or expire') });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('reports persistence failures without claiming a reset', async () => {
    mocks.insert.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await post()).status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
