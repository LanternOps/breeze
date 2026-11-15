import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG = '11111111-1111-4111-8111-111111111111';
const state = vi.hoisted(() => ({
  row: { devices: 10, attested: 6, noTpm: 1 } as Record<string, number> | undefined,
  allowedSiteIds: undefined as string[] | undefined,
  canAccessOrg: true,
  selects: 0,
}));

vi.mock('../../db', async (importOriginal) => {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: async () => (state.row ? [state.row] : []),
  };
  return {
    ...await importOriginal<typeof import('../../db')>(),
    db: { select: vi.fn(() => { state.selects += 1; return chain; }) },
  };
});
vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      user: { id: 'user-1' },
      scope: 'partner', orgId: null, partnerId: 'p-1',
      accessibleOrgIds: [ORG],
      canAccessOrg: () => state.canAccessOrg,
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', { permissions: [], allowedSiteIds: state.allowedSiteIds });
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

const app = new Hono();
app.route('/devices', deviceRoutes);

beforeEach(() => {
  state.row = { devices: 10, attested: 6, noTpm: 1 };
  state.allowedSiteIds = undefined;
  state.canAccessOrg = true;
  state.selects = 0;
});

describe('GET /devices/tpm-coverage (#8318 T1, §12.2)', () => {
  it('is mounted before core GET /:id and splits the fleet three ways', async () => {
    const res = await app.request('/devices/tpm-coverage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ coverage: { devices: 10, attested: 6, noTpm: 1, notAttested: 3 } });
  });

  it('answers zeros for an empty site allowlist without a query', async () => {
    state.allowedSiteIds = [];
    const res = await app.request('/devices/tpm-coverage');
    expect(await res.json()).toEqual({ coverage: { devices: 0, attested: 0, noTpm: 0, notAttested: 0 } });
    expect(state.selects).toBe(0);
  });

  it('refuses an org the caller cannot reach, and a malformed one', async () => {
    state.canAccessOrg = false;
    expect((await app.request(`/devices/tpm-coverage?orgId=${ORG}`)).status).toBe(403);
    expect((await app.request('/devices/tpm-coverage?orgId=nope')).status).toBe(400);
    expect(state.selects).toBe(0);
  });
});
