/**
 * IOC sweep routes (#6263 W05-6). The service is mocked (services/
 * securityScanSweeps.test.ts pins its behaviour); this pins the HTTP surface:
 * permission gates, validation, status/code pass-through, origin and MFA
 * inputs, and the self-managed-context registration of the write routes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { svc, getUserPermissionsMock } = vi.hoisted(() => ({
  svc: {
    previewSweep: vi.fn(),
    createSweep: vi.fn(),
    listSweeps: vi.fn(),
    getSweep: vi.fn(),
    getSweepGroup: vi.fn(),
    cancelSweep: vi.fn(),
    cancelSweepGroup: vi.fn(),
  },
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    hasSatisfiedMfa: vi.fn((auth: any) => auth.token?.mfa === true),
  };
});
vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});
vi.mock('../../services/securityScanSweeps', () => svc);

import { sweepsRoutes } from './sweeps';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const SWEEP = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'f'.repeat(64);

const EXECUTE = [{ resource: 'devices', action: 'execute' }, { resource: 'devices', action: 'read' }];
const VIEWER = [{ resource: 'devices', action: 'read' }];

function app(auth: Record<string, unknown> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      token: { mfa: true },
      scope: 'partner', orgId: null, partnerId: 'p-1', accessibleOrgIds: [ORG],
      user: { id: 'u-1', email: 'u@example.test', name: 'U' },
      canAccessOrg: (id: string) => id === ORG,
      orgCondition: () => undefined,
      ...auth,
    } as any);
    await next();
  });
  a.route('/security', sweepsRoutes);
  return a;
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const request = { ruleSetIds: [SET], scope: { kind: 'all' }, scanType: 'quick' };
const summary = { id: SWEEP, groupId: GROUP, orgId: ORG, state: 'active' };

beforeEach(() => {
  vi.clearAllMocks();
  getUserPermissionsMock.mockResolvedValue({ permissions: EXECUTE, scope: 'partner' });
});

describe('IOC sweep routes', () => {
  it('viewer → 403 on preview/create/cancel', async () => {
    getUserPermissionsMock.mockResolvedValue({ permissions: VIEWER, scope: 'partner' });
    const a = app();
    expect((await a.request('/security/sweeps/preview', json('POST', request))).status).toBe(403);
    expect((await a.request('/security/sweeps', json('POST', { ...request, previewDigest: DIGEST }))).status).toBe(403);
    expect((await a.request(`/security/sweeps/${SWEEP}/cancel`, json('POST'))).status).toBe(403);
    expect((await a.request(`/security/sweeps/groups/${GROUP}/cancel`, json('POST'))).status).toBe(403);
    expect(svc.previewSweep).not.toHaveBeenCalled();
    expect(svc.createSweep).not.toHaveBeenCalled();
    expect(svc.cancelSweep).not.toHaveBeenCalled();
    // ...and reads need devices:read only.
    svc.listSweeps.mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 });
    expect((await a.request('/security/sweeps')).status).toBe(200);
  });

  it('400 invalid body', async () => {
    const a = app();
    expect((await a.request('/security/sweeps/preview', json('POST', { ...request, scope: { kind: 'nope' } }))).status).toBe(400);
    expect((await a.request('/security/sweeps', json('POST', request))).status).toBe(400); // no previewDigest
    expect((await a.request('/security/sweeps', json('POST', { ...request, previewDigest: DIGEST, scanType: 'custom' }))).status).toBe(400);
    expect((await a.request('/security/sweeps/not-a-uuid')).status).toBe(400);
    expect(svc.previewSweep).not.toHaveBeenCalled();
    expect(svc.createSweep).not.toHaveBeenCalled();
  });

  it('preview returns the preview', async () => {
    const preview = { targeted: 2, byOrg: [], skipped: {}, ruleSets: [], previewDigest: DIGEST };
    svc.previewSweep.mockResolvedValue({ ok: true, preview });
    const res = await app().request('/security/sweeps/preview', json('POST', request));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: preview });
    expect(svc.previewSweep).toHaveBeenCalledWith(expect.objectContaining({ user: expect.anything() }), request);
  });

  it('201 shape', async () => {
    svc.createSweep.mockResolvedValue({ ok: true, groupId: GROUP, sweeps: [summary] });
    const res = await app().request('/security/sweeps', json('POST', { ...request, previewDigest: DIGEST, ttlHours: 6 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { groupId: GROUP, sweeps: [summary] } });
    const [, body, ctx] = svc.createSweep.mock.calls[0]!;
    expect(body).toEqual({ ...request, previewDigest: DIGEST, ttlHours: 6 });
    expect(ctx).toMatchObject({ origin: 'web', mfaSatisfied: true, requestMeta: expect.any(Object) });
  });

  it('409/403 codes pass through with detail', async () => {
    const a = app();
    for (const failure of [
      { ok: false, status: 409, code: 'SWEEP_SCOPE_CHANGED', detail: { preview: { targeted: 3 } } },
      { ok: false, status: 409, code: 'SWEEP_ALREADY_RUNNING', detail: { sweepIds: [SWEEP], groupIds: [GROUP] } },
      { ok: false, status: 409, code: 'TOO_MANY_ACTIVE_SWEEPS', detail: { orgIds: [ORG], max: 5 } },
      { ok: false, status: 403, code: 'MFA_REQUIRED', detail: { targeted: 51, threshold: 50 } },
      { ok: false, status: 403, code: 'SITE_OUT_OF_SCOPE', detail: { siteIds: ['s'] } },
      { ok: false, status: 404, code: 'RULE_SET_NOT_FOUND', detail: { ruleSetIds: [SET] } },
      { ok: false, status: 400, code: 'NO_ELIGIBLE_DEVICES', detail: { skipped: {} } },
      { ok: false, status: 429, code: 'RATE_LIMITED', detail: { retryAt: 'x' } },
    ]) {
      svc.createSweep.mockResolvedValueOnce(failure);
      const res = await a.request('/security/sweeps', json('POST', { ...request, previewDigest: DIGEST }));
      expect(res.status).toBe(failure.status);
      expect(await res.json()).toMatchObject({ code: failure.code, detail: failure.detail, error: expect.any(String) });
    }
    svc.previewSweep.mockResolvedValueOnce({ ok: false, status: 403, code: 'ORG_OUT_OF_SCOPE', detail: { orgIds: [ORG] } });
    const res = await a.request('/security/sweeps/preview', json('POST', request));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ORG_OUT_OF_SCOPE', detail: { orgIds: [ORG] } });
  });

  it('list paginates/filters by state', async () => {
    svc.listSweeps.mockResolvedValue({ data: [summary], total: 41, page: 2, limit: 20 });
    const res = await app().request(`/security/sweeps?state=active&orgId=${ORG}&page=2&limit=20`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [summary], pagination: { page: 2, limit: 20, total: 41 } });
    expect(svc.listSweeps).toHaveBeenCalledWith(expect.anything(), { state: 'active', orgId: ORG, page: 2, limit: 20 });
    expect((await app().request('/security/sweeps?state=done')).status).toBe(400);
    expect((await app().request('/security/sweeps?limit=500')).status).toBe(400);
  });

  it('get one / group; 404 when not visible', async () => {
    svc.getSweep.mockResolvedValueOnce(summary).mockResolvedValueOnce(null);
    expect(await (await app().request(`/security/sweeps/${SWEEP}`)).json()).toEqual({ data: summary });
    expect((await app().request(`/security/sweeps/${SWEEP}`)).status).toBe(404);

    const group = { groupId: GROUP, sweeps: [summary], targeted: 3, progress: { queued: 3 } };
    svc.getSweepGroup.mockResolvedValueOnce(group).mockResolvedValueOnce(null);
    expect(await (await app().request(`/security/sweeps/groups/${GROUP}`)).json()).toEqual({ data: group });
    expect((await app().request(`/security/sweeps/groups/${GROUP}`)).status).toBe(404);
  });

  it('group sums visible rows only (the service-computed group is returned as is)', async () => {
    const group = { groupId: GROUP, sweeps: [summary], targeted: 1, progress: { queued: 1 } };
    svc.getSweepGroup.mockResolvedValue(group);
    const { data } = await (await app().request(`/security/sweeps/groups/${GROUP}`)).json();
    expect(data.sweeps).toHaveLength(1);
    expect(svc.getSweepGroup).toHaveBeenCalledWith(expect.anything(), GROUP);
  });

  it('cancel by id and by group', async () => {
    const done = { ok: true, sweeps: [{ ...summary, state: 'cancelled' }], cancelledQueued: 3, cancelledUndelivered: 1, stillRunning: 2 };
    svc.cancelSweep.mockResolvedValueOnce(done).mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({ ok: false, status: 403 });
    const a = app();
    const ok = await a.request(`/security/sweeps/${SWEEP}/cancel`, json('POST'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { sweeps: done.sweeps, cancelledQueued: 3, cancelledUndelivered: 1, stillRunning: 2 } });
    expect(svc.cancelSweep).toHaveBeenCalledWith(expect.anything(), SWEEP, { requestMeta: expect.any(Object) });
    expect((await a.request(`/security/sweeps/${SWEEP}/cancel`, json('POST'))).status).toBe(404);
    expect((await a.request(`/security/sweeps/${SWEEP}/cancel`, json('POST'))).status).toBe(403);

    svc.cancelSweepGroup.mockResolvedValueOnce(done);
    expect((await a.request(`/security/sweeps/groups/${GROUP}/cancel`, json('POST'))).status).toBe(200);
    expect(svc.cancelSweepGroup).toHaveBeenCalledWith(expect.anything(), GROUP, { requestMeta: expect.any(Object) });
  });

  it('api key → origin api, MFA rule above 50', async () => {
    svc.createSweep.mockResolvedValue({ ok: false, status: 403, code: 'MFA_REQUIRED', detail: { targeted: 51, threshold: 50 } });
    const res = await app({ principal: { kind: 'api_key', apiKeyId: 'k-1' }, token: {} }).request(
      '/security/sweeps',
      json('POST', { ...request, previewDigest: DIGEST }),
    );
    expect(res.status).toBe(403);
    const [, , ctx] = svc.createSweep.mock.calls[0]!;
    expect(ctx).toMatchObject({ origin: 'api', mfaSatisfied: false });
  });

  it('a user session without satisfied MFA is passed as such', async () => {
    svc.createSweep.mockResolvedValue({ ok: true, groupId: GROUP, sweeps: [] });
    await app({ token: { mfa: false } }).request('/security/sweeps', json('POST', { ...request, previewDigest: DIGEST }));
    expect(svc.createSweep.mock.calls[0]![2]).toMatchObject({ origin: 'web', mfaSatisfied: false });
  });

  it('create and both cancels run with no request transaction; preview and reads keep it', () => {
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/security/sweeps')).toBe(true);
    expect(isSelfManagedDbContextRoute('POST', `/api/v1/security/sweeps/${SWEEP}/cancel`)).toBe(true);
    expect(isSelfManagedDbContextRoute('POST', `/api/v1/security/sweeps/groups/${GROUP}/cancel`)).toBe(true);
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/security/sweeps/preview')).toBe(false);
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/security/sweeps')).toBe(false);
    expect(isSelfManagedDbContextRoute('GET', `/api/v1/security/sweeps/${SWEEP}`)).toBe(false);
  });
});
