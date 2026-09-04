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

const serviceMocks = vi.hoisted(() => ({ getPeriodOutcome: vi.fn() }));
vi.mock('../../services/billingEvidence', () => ({ getPeriodOutcome: serviceMocks.getPeriodOutcome }));

vi.mock('./contracts', () => ({
  contractActorFrom: (c: any) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, partnerId: auth.partnerId, accessibleOrgIds: auth.accessibleOrgIds };
  },
  handleContractError: (c: any, err: any) => c.json({ error: err.message, code: err.code }, err.status),
}));

import { authMiddleware } from '../../middleware/auth';
import { contractPeriodRoutes } from './periods';

const { getPeriodOutcome } = serviceMocks;

const CONTRACT = '11111111-1111-4111-8111-111111111111';
const PERIOD = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_CONTRACT = '33333333-3333-4333-8333-333333333333';
const OTHER_CONTRACTS_PERIOD = '44444444-4444-4444-8444-444444444444';
const OLD_PERIOD = '55555555-5555-4555-8555-555555555555';
const PATH = `/${CONTRACT}/periods/${PERIOD}/outcome`;
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', contractPeriodRoutes);

describe('contract period outcome route (#3205 W07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPeriodOutcome.mockResolvedValue({ recorded: true, outcome: { contractBillingPeriodId: PERIOD } });
  });

  it('401 unauthenticated', async () => expect((await app.request(PATH)).status).toBe(401));

  it('403 without contracts:read', async () =>
    expect((await app.request(PATH, { headers: NO_PERM })).status).toBe(403));

  it('404 for a cross-tenant contract id', async () => {
    getPeriodOutcome.mockRejectedValueOnce({ status: 404, code: 'CONTRACT_NOT_FOUND', message: 'Contract not found' });
    const res = await app.request(`/${OTHER_ORG_CONTRACT}/periods/${PERIOD}/outcome`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('404 for a period id from another contract (same-parent ownership)', async () => {
    getPeriodOutcome.mockRejectedValueOnce({ status: 404, code: 'PERIOD_NOT_FOUND', message: 'Billing period not found' });
    const res = await app.request(`/${CONTRACT}/periods/${OTHER_CONTRACTS_PERIOD}/outcome`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('200 with a recorded outcome', async () => {
    const res = await app.request(PATH, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { recorded: true, outcome: expect.any(Object) } });
  });

  it('200 { recorded: false, outcome: null } for a pre-W07 period', async () => {
    getPeriodOutcome.mockResolvedValueOnce({ recorded: false, outcome: null });
    const res = await app.request(`/${CONTRACT}/periods/${OLD_PERIOD}/outcome`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { recorded: false, outcome: null } });
  });

  it('400 for invalid contract and period ids', async () => {
    expect((await app.request(`/bad/periods/${PERIOD}/outcome`, { headers: AUTH })).status).toBe(400);
    expect((await app.request(`/${CONTRACT}/periods/bad/outcome`, { headers: AUTH })).status).toBe(400);
  });

  it('is mounted BEFORE contractCrudRoutes', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src.indexOf('contractPeriodRoutes')).toBeLessThan(src.indexOf('contractCrudRoutes'));
  });
});
