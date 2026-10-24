/**
 * Pre-DB gates of /security/yara (#6263 W03a). Visibility, ownership, built-in
 * and publish behaviour are proven on real Postgres in
 * __tests__/integration/yaraRuleSetRoutes.integration.test.ts; this file pins
 * the gates that must refuse BEFORE any database write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { insertMock, selectMock, updateMock, publishMock, getUserPermissionsMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  publishMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { insert: insertMock, select: selectMock, update: updateMock, delete: vi.fn() },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../services/auditEvents', async () => {
  const actual = await vi.importActual<any>('../../services/auditEvents');
  return { ...actual, writeRouteAudit: vi.fn() };
});
vi.mock('../../services/yaraRuleSetPublisher', () => ({ publishRuleSet: publishMock }));

import { yaraRoutes } from './yara';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';

function app(auth: Record<string, unknown>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: 'p-1', accessibleOrgIds: [ORG],
      user: { id: 'u-1', email: 'u@example.test' },
      canAccessOrg: (id: string) => id === ORG,
      orgCondition: () => undefined,
      ...auth,
    } as any);
    await next();
  });
  a.route('/security', yaraRoutes);
  return a;
}

const post = (a: Hono, path: string, body: unknown) =>
  a.request(`/security${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (a: Hono, path: string, body: unknown) =>
  a.request(`/security${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function mockVisibleSet(row: Record<string, unknown>) {
  selectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserPermissionsMock.mockResolvedValue({
    permissions: [{ resource: 'devices', action: 'write' }, { resource: 'devices', action: 'read' }],
    partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization',
  });
});

describe('/security/yara pre-DB gates', () => {
  it('a site-restricted caller cannot create a rule set (no DB write)', async () => {
    const res = await post(app({ allowedSiteIds: ['33333333-3333-4333-8333-333333333333'] }), '/yara/rule-sets', { name: 'x' });
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('a site-restricted caller cannot edit a visible org set', async () => {
    mockVisibleSet({ id: SET, orgId: ORG, partnerId: null, isBuiltin: false, autoQuarantine: false, enabled: true, currentVersion: 1 });
    const res = await patch(app({ allowedSiteIds: [] }), `/yara/rule-sets/${SET}`, { name: 'y' });
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('creating a set with auto-quarantine ON needs devices:execute', async () => {
    const res = await post(app({}), '/yara/rule-sets', { name: 'x', autoQuarantine: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('AUTO_QUARANTINE_EXECUTE_REQUIRED');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('turning auto-quarantine ON needs devices:execute; turning it OFF does not', async () => {
    mockVisibleSet({ id: SET, orgId: ORG, partnerId: null, isBuiltin: false, autoQuarantine: false, enabled: true, currentVersion: 1 });
    const on = await patch(app({}), `/yara/rule-sets/${SET}`, { autoQuarantine: true });
    expect(on.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();

    mockVisibleSet({ id: SET, orgId: ORG, partnerId: null, isBuiltin: false, autoQuarantine: true, enabled: true, currentVersion: 1 });
    updateMock.mockReturnValueOnce({ set: () => ({ where: () => Promise.resolve([]) }) });
    publishMock.mockResolvedValueOnce({ published: true, version: 2, currentVersion: 2, stale: false, errors: [] });
    mockVisibleSet({ id: SET, orgId: ORG, partnerId: null, isBuiltin: false, autoQuarantine: false, enabled: true, currentVersion: 2, name: 'n', description: null, source: 'custom', publishedVersion: 2, publishedSha256: null, publishedAt: null, publishedEngine: null, stale: false, ruleCount: 1, createdAt: new Date(), updatedAt: new Date() });
    const off = await patch(app({}), `/yara/rule-sets/${SET}`, { autoQuarantine: false });
    expect(off.status).toBe(200);
    expect(publishMock).toHaveBeenCalledWith(SET);
  });

  it('an org caller cannot create a set for an org it cannot access', async () => {
    const res = await post(app({}), '/yara/rule-sets', { name: 'x', orgId: '44444444-4444-4444-8444-444444444444' });
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('a create without devices:write is refused by RBAC', async () => {
    getUserPermissionsMock.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'read' }], partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization' });
    const res = await post(app({}), '/yara/rule-sets', { name: 'x' });
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('POST /yara/rule-sets/:id/rules cap vs. set lock (#9176)', () => {
  const body = { name: 'r1', source: 'rule r1 { condition: true }' };

  it('locks the set row BEFORE counting rules, and refuses at the cap without inserting', async () => {
    const order: string[] = [];
    mockVisibleSet({ id: SET, orgId: ORG, partnerId: null, isBuiltin: false, autoQuarantine: false, enabled: true, currentVersion: 1 });
    // 2nd select: the FOR UPDATE lock.
    selectMock.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          for: (mode: string) => {
            order.push(`lock:${mode}`);
            return Promise.resolve([{ id: SET }]);
          },
        }),
      }),
    });
    // 3rd select: the count.
    selectMock.mockReturnValueOnce({
      from: () => ({
        where: () => {
          order.push('count');
          return Promise.resolve([{ value: 500 }]);
        },
      }),
    });

    const res = await post(app({}), `/yara/rule-sets/${SET}/rules`, body);
    expect(res.status).toBe(400);
    expect(order).toEqual(['lock:update', 'count']);
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('POST /yara/rule-sets/:id/rules set vanished before lock (#9176)', () => {
  it('404s without counting or inserting when the lock finds no row', async () => {
    mockVisibleSet({ id: SET, orgId: ORG, partnerId: null, isBuiltin: false, autoQuarantine: false, enabled: true, currentVersion: 1 });
    selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => Promise.resolve([]) }) }) });
    const res = await post(app({}), `/yara/rule-sets/${SET}/rules`, { name: 'r1', source: 'rule r1 { condition: true }' });
    expect(res.status).toBe(404);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
