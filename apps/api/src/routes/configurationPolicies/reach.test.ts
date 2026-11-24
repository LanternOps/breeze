import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { getConfigPolicyMock, computeMock, readableMock, state } = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  computeMock: vi.fn(),
  readableMock: vi.fn(),
  state: { permissions: new Set<string>() },
}));

vi.mock('../../services/configurationPolicy', () => ({ getConfigPolicy: getConfigPolicyMock }));
vi.mock('../../services/configPolicyReach', () => ({
  computePolicyReach: computeMock,
  readablePolicyIds: readableMock,
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: (_c: any, next: any) => next(),
  requireScope: () => (_c: any, next: any) => next(),
  // Real-ish gate: 403 unless the test granted `resource.action`.
  requirePermission: (resource: string, action: string) => (c: any, next: any) =>
    state.permissions.has(`${resource}.${action}`) ? next() : c.json({ error: 'Permission denied' }, 403),
}));

import { reachRoutes } from './reach';

const ORG = '11111111-1111-4111-8111-111111111111';
const POLICY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTH = { scope: 'organization', orgId: ORG, user: { id: 'u1', email: 'u@example.com' } };

function guid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', AUTH as any);
    await next();
  });
  app.route('/', reachRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = new Set(['devices.read']);
  readableMock.mockImplementation(async (_auth: unknown, ids: string[]) => ids);
  computeMock.mockImplementation(async (_auth: unknown, ids: string[]) =>
    new Map(ids.map((id) => [id, { direct: 1, throughChildren: 0, organizations: 1 }])),
  );
  getConfigPolicyMock.mockResolvedValue({ id: POLICY_A, orgId: ORG, name: 'P' });
});

describe('GET /reach', () => {
  it('GET /reach rejects more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => guid(i + 1)).join(',');
    const res = await makeApp().request(`/reach?ids=${ids}`);
    expect(res.status).toBe(400);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('accepts 100 ids, and counts a repeated id once toward the limit', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => guid(i + 1));
    const res = await makeApp().request(`/reach?ids=${[...hundred, hundred[0]].join(',')}`);
    expect(res.status).toBe(200);
    expect(readableMock).toHaveBeenCalledWith(AUTH, hundred);
  });

  it('GET /reach rejects a non-guid', async () => {
    const res = await makeApp().request(`/reach?ids=${POLICY_A},not-a-guid`);
    expect(res.status).toBe(400);
    expect(readableMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or empty id list', async () => {
    expect((await makeApp().request('/reach')).status).toBe(400);
    expect((await makeApp().request('/reach?ids=')).status).toBe(400);
  });

  it('GET /reach omits ids the caller cannot read', async () => {
    readableMock.mockResolvedValue([POLICY_A]);
    const res = await makeApp().request(`/reach?ids=${POLICY_A},${POLICY_B}`);
    expect(res.status).toBe(200);
    // Only the readable ids reach the count; the client's list is never trusted.
    expect(computeMock).toHaveBeenCalledWith(AUTH, [POLICY_A]);
    const body = await res.json();
    expect(body).toEqual({ data: { [POLICY_A]: { direct: 1, throughChildren: 0, organizations: 1 } } });
  });

  it('answers an empty map without counting when nothing is readable', async () => {
    readableMock.mockResolvedValue([]);
    const res = await makeApp().request(`/reach?ids=${POLICY_A}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: {} });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('403s without devices.read', async () => {
    state.permissions = new Set();
    expect((await makeApp().request(`/reach?ids=${POLICY_A}`)).status).toBe(403);
  });
});

describe('GET /:id/reach', () => {
  it('GET /:id/reach 404s on an invisible policy', async () => {
    getConfigPolicyMock.mockResolvedValue(null);
    const res = await makeApp().request(`/${POLICY_A}/reach`);
    expect(res.status).toBe(404);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('GET /:id/reach returns the three counts', async () => {
    computeMock.mockResolvedValue(new Map([[POLICY_A, { direct: 12, throughChildren: 30, organizations: 3 }]]));
    const res = await makeApp().request(`/${POLICY_A}/reach`);
    expect(res.status).toBe(200);
    expect(getConfigPolicyMock).toHaveBeenCalledWith(POLICY_A, AUTH, { access: 'read' });
    expect(computeMock).toHaveBeenCalledWith(AUTH, [POLICY_A]);
    expect(await res.json()).toEqual({ direct: 12, throughChildren: 30, organizations: 3 });
  });

  it('never answers zero counts for a policy the count read did not return', async () => {
    computeMock.mockResolvedValue(new Map());
    const res = await makeApp().request(`/${POLICY_A}/reach`);
    expect(res.status).toBe(404);
  });

  it('rejects a non-guid id', async () => {
    expect((await makeApp().request('/nope/reach')).status).toBe(400);
  });

  it('403s without devices.read', async () => {
    state.permissions = new Set();
    expect((await makeApp().request(`/${POLICY_A}/reach`)).status).toBe(403);
  });
});

describe('mount order', () => {
  it('mounts reachRoutes before crudRoutes, so /reach is never read as /:id', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const reachAt = index.indexOf("configPolicyRoutes.route('/', reachRoutes)");
    const crudAt = index.indexOf("configPolicyRoutes.route('/', crudRoutes)");
    expect(reachAt).toBeGreaterThan(-1);
    expect(crudAt).toBeGreaterThan(reachAt);
  });
});
