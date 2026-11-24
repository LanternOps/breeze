import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { getConfigPolicyMock, computeMock, state } = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  computeMock: vi.fn(),
  state: { permissions: new Set<string>() },
}));

vi.mock('../../services/configurationPolicy', () => ({ getConfigPolicy: getConfigPolicyMock }));
vi.mock('../../services/configPolicyPrecedence', () => ({ computePolicyPrecedence: computeMock }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: (_c: any, next: any) => next(),
  requireScope: () => (_c: any, next: any) => next(),
  // Real-ish gate: 403 unless the test granted `resource.action`.
  requirePermission: (resource: string, action: string) => (c: any, next: any) =>
    state.permissions.has(`${resource}.${action}`) ? next() : c.json({ error: 'Permission denied' }, 403),
}));

import { precedenceRoutes } from './precedence';

const ORG = '11111111-1111-4111-8111-111111111111';
const POLICY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTH = { scope: 'organization', orgId: ORG, user: { id: 'u1', email: 'u@example.com' } };

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', AUTH as any);
    await next();
  });
  app.route('/', precedenceRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = new Set(['devices.read']);
  getConfigPolicyMock.mockResolvedValue({ id: POLICY, orgId: ORG, name: 'P' });
  computeMock.mockResolvedValue({ capped: false, features: { patch: { reached: 4, outranked: 1 } } });
});

describe('GET /:id/precedence', () => {
  it('GET /:id/precedence 404s on an invisible policy', async () => {
    getConfigPolicyMock.mockResolvedValue(null);
    const res = await makeApp().request(`/${POLICY}/precedence`);
    expect(res.status).toBe(404);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns the per-feature counts, read through the access-filtered policy read', async () => {
    const res = await makeApp().request(`/${POLICY}/precedence`);
    expect(res.status).toBe(200);
    // The read predicate (W03a): an org admin sees the counts of an MSP-managed
    // policy that applies to its organization, as on reach.
    expect(getConfigPolicyMock).toHaveBeenCalledWith(POLICY, AUTH, { access: 'read' });
    expect(computeMock).toHaveBeenCalledWith(AUTH, POLICY);
    expect(await res.json()).toEqual({ capped: false, features: { patch: { reached: 4, outranked: 1 } } });
  });

  it('returns capped over the cap', async () => {
    computeMock.mockResolvedValue({ capped: true });
    const res = await makeApp().request(`/${POLICY}/precedence`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capped: true });
  });

  it('never answers counts for a policy the count read did not return', async () => {
    computeMock.mockResolvedValue(null);
    expect((await makeApp().request(`/${POLICY}/precedence`)).status).toBe(404);
  });

  it('rejects a non-guid id', async () => {
    expect((await makeApp().request('/nope/precedence')).status).toBe(400);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('403s without devices.read', async () => {
    state.permissions = new Set();
    expect((await makeApp().request(`/${POLICY}/precedence`)).status).toBe(403);
    expect(computeMock).not.toHaveBeenCalled();
  });
});

describe('mount order', () => {
  it('mounts precedenceRoutes before crudRoutes', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const at = index.indexOf("configPolicyRoutes.route('/', precedenceRoutes)");
    const crudAt = index.indexOf("configPolicyRoutes.route('/', crudRoutes)");
    expect(at).toBeGreaterThan(-1);
    expect(crudAt).toBeGreaterThan(at);
  });
});
