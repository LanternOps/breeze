import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'], scope: 'partner' });
    c.set('permissions', { permissions: [{ resource: 'contracts', action: 'read' }] });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (c: any, next: any) =>
    c.req.header('x-allow') === 'true' ? next() : c.json({ error: 'Forbidden' }, 403),
}));

const dbMocks = vi.hoisted(() => ({ rows: [] as Array<{ id: string; orgId: string }> }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => dbMocks.rows) })),
    })),
  },
}));

const serviceMocks = vi.hoisted(() => ({ listDeliverables: vi.fn() }));
vi.mock('../../services/serviceDeliverableService', () => ({
  ...serviceMocks,
  // deliverables.ts pulls actor/error helpers from ../serviceDeliverables, which imports every service name.
  getDeliverable: vi.fn(), createDeliverable: vi.fn(), updateDeliverable: vi.fn(), deactivateDeliverable: vi.fn(), listOccurrences: vi.fn(), deliverOccurrence: vi.fn(), waiveOccurrence: vi.fn(), reopenOccurrence: vi.fn(), rescheduleOccurrence: vi.fn(), addEvidence: vi.fn(), removeEvidence: vi.fn(),
  DeliverableServiceError: class DeliverableServiceError extends Error {
    constructor(msg: string, public status = 400, public code = 'ERR', public details?: unknown) { super(msg); }
  },
}));

import { authMiddleware } from '../../middleware/auth';
import { contractDeliverableRoutes } from './deliverables';

const { listDeliverables } = serviceMocks;

const CONTRACT = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PATH = `/${CONTRACT}/deliverables`;
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', contractDeliverableRoutes);

describe('contract deliverables route (#5573 W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.rows = [{ id: CONTRACT, orgId: ORG }];
    listDeliverables.mockResolvedValue([{ id: 'd1', contractId: CONTRACT }]);
  });

  it('401 unauthenticated', async () => expect((await app.request(PATH)).status).toBe(401));

  it('403 without contracts:read', async () =>
    expect((await app.request(PATH, { headers: NO_PERM })).status).toBe(403));

  it('404 CONTRACT_NOT_FOUND when the contract lookup returns nothing', async () => {
    dbMocks.rows = [];
    const res = await app.request(PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'CONTRACT_NOT_FOUND' });
    expect(listDeliverables).not.toHaveBeenCalled();
  });

  it("200 { data } listing by the contract's org and id with the actor", async () => {
    const res = await app.request(PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'd1', contractId: CONTRACT }] });
    expect(listDeliverables).toHaveBeenCalledWith(
      ORG, { contractId: CONTRACT }, { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] },
    );
  });

  it('404 when the service hides a cross-tenant org', async () => {
    listDeliverables.mockRejectedValueOnce({ status: 404, code: 'NOT_FOUND', message: 'Not found' });
    const res = await app.request(PATH, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('400 for an invalid contract id', async () =>
    expect((await app.request('/bad/deliverables', { headers: AUTH })).status).toBe(400));

  it('is mounted BEFORE contractCrudRoutes', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src.indexOf('contractDeliverableRoutes')).toBeGreaterThan(-1);
    expect(src.indexOf('contractRoutes.route(\'/\', contractDeliverableRoutes')).toBeLessThan(
      src.indexOf('contractRoutes.route(\'/\', contractCrudRoutes'),
    );
  });
});
