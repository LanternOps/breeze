import { describe, expect, it, vi } from 'vitest';
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

import { deviceRoutes } from './index';

describe('device attention-counts mount order (#9038)', () => {
  it('routes /devices/attention-counts to the batch reader before core GET /:id', async () => {
    const app = new Hono();
    app.route('/devices', deviceRoutes);
    // An empty id list short-circuits before any query, so no db mock is needed.
    const response = await app.request('/devices/attention-counts?ids=');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counts: {} });
  });
});
