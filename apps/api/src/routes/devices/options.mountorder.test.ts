import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../db')>(),
  db: { select: vi.fn() },
}));
vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      user: { id: 'user-1' },
      scope: 'organization', orgId: '11111111-1111-4111-8111-111111111111', partnerId: null,
      accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
      canAccessOrg: () => true, orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', { permissions: [], allowedSiteIds: undefined });
    return next();
  }),
}));

vi.mock('./core', async () => {
  const { Hono } = await import('hono');
  const coreRoutes = new Hono();
  coreRoutes.get('/:id', (c) => c.json({ handler: 'core', id: c.req.param('id') }));
  return { coreRoutes };
});

import { db } from '../../db';
import { deviceRoutes } from './index';

function queryChain(result: unknown) {
  const chain: any = {};
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { from: vi.fn(() => chain) };
}

describe('device options mount order', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes /devices/options to the static selector before core GET /:id', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(queryChain([{ count: 0 }]) as never)
      .mockReturnValueOnce(queryChain([]) as never);
    const app = new Hono();
    app.route('/devices', deviceRoutes);
    const response = await app.request('/devices/options');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], page: { total: 0 } });
  });
});
