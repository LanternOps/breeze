import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { getConfigPolicyMock, listMock, allowMock, auditMock, state } = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  listMock: vi.fn(),
  allowMock: vi.fn(),
  auditMock: vi.fn(),
  state: { permissions: new Set<string>(), allowedSiteIds: undefined as string[] | undefined },
}));

vi.mock('../../services/configurationPolicy', () => ({ getConfigPolicy: getConfigPolicyMock }));
vi.mock('../../services/wakeStatusPanel', () => ({
  listWakeStatusForPolicy: listMock,
  allowWakeAgain: allowMock,
  WAKE_PANEL_STATES: ['ready', 'unproven', 'no_data'],
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: auditMock }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: (_c: any, next: any) => next(),
  requireScope: () => (_c: any, next: any) => next(),
  // Real-ish gate: 403 unless the test granted `resource.action`.
  requirePermission: (resource: string, action: string) => (c: any, next: any) =>
    state.permissions.has(`${resource}.${action}`) ? next() : c.json({ error: 'Permission denied' }, 403),
}));

import { wakeStatusRoutes } from './wakeStatus';

const POLICY = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const ORG = '11111111-1111-4111-8111-111111111111';

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { scope: 'organization', orgId: ORG, user: { id: 'u1', email: 'u@example.com' } } as any);
    c.set('permissions', { allowedSiteIds: state.allowedSiteIds } as any);
    await next();
  });
  app.route('/', wakeStatusRoutes);
  return app;
}

const emptyPage = { data: [], counts: {}, total: 0, page: 1, limit: 50, scanned: 0, capped: false };

describe('GET /:id/wake-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = new Set(['devices.read', 'devices.execute']);
    state.allowedSiteIds = undefined;
    getConfigPolicyMock.mockResolvedValue({ id: POLICY, orgId: ORG, name: 'P' });
    listMock.mockResolvedValue(emptyPage);
  });

  it('404s a policy the caller cannot see and never scans', async () => {
    getConfigPolicyMock.mockResolvedValue(null);
    const res = await makeApp().request(`/${POLICY}/wake-status`);
    expect(res.status).toBe(404);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('403s without devices.read', async () => {
    state.permissions = new Set();
    expect((await makeApp().request(`/${POLICY}/wake-status`)).status).toBe(403);
  });

  it('passes paging, state filter and the caller site allowlist to the service', async () => {
    state.allowedSiteIds = ['s1'];
    const res = await makeApp().request(`/${POLICY}/wake-status?page=2&limit=25&state=unproven`);
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith({ policyId: POLICY, allowedSiteIds: ['s1'], page: 2, limit: 25, state: 'unproven' });
  });

  it('returns the service payload including capped', async () => {
    listMock.mockResolvedValue({ ...emptyPage, scanned: 5000, capped: true, counts: { ready: 3 } });
    const body = await (await makeApp().request(`/${POLICY}/wake-status`)).json();
    expect(body.capped).toBe(true);
    expect(body.counts).toEqual({ ready: 3 });
  });

  it('rejects an unknown state', async () => {
    expect((await makeApp().request(`/${POLICY}/wake-status?state=bogus`)).status).toBe(400);
  });
});

describe('POST /:id/wake-status/:deviceId/allow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = new Set(['devices.read', 'devices.execute']);
    state.allowedSiteIds = undefined;
    getConfigPolicyMock.mockResolvedValue({ id: POLICY, orgId: ORG, name: 'P' });
    allowMock.mockResolvedValue({ orgId: ORG, hostname: 'host-1' });
  });

  const post = () => makeApp().request(`/${POLICY}/wake-status/${DEVICE}/allow`, { method: 'POST' });

  it('requires devices.execute', async () => {
    state.permissions = new Set(['devices.read']);
    expect((await post()).status).toBe(403);
    expect(allowMock).not.toHaveBeenCalled();
  });

  it('404s an ungoverned device without auditing', async () => {
    allowMock.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('404s a policy the caller cannot see', async () => {
    getConfigPolicyMock.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(allowMock).not.toHaveBeenCalled();
  });

  it('resets and writes an audit row naming the policy', async () => {
    state.allowedSiteIds = ['s1'];
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(allowMock).toHaveBeenCalledWith({ policyId: POLICY, deviceId: DEVICE, allowedSiteIds: ['s1'] });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG,
      action: 'device.wake_on_lan.allow_again',
      resourceType: 'device',
      resourceId: DEVICE,
      details: expect.objectContaining({ policyId: POLICY }),
    }));
  });
});
