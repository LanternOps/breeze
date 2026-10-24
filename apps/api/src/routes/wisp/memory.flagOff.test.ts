/**
 * Wisp W03 — "flag off = no behaviour change", with the REAL wispEnabled()
 * (memory.test.ts mocks it). BREEZE_WISP_ENABLED unset ⇒ every memory route
 * answers 404 and the service is never reached, even for a fully authorized
 * partner user, and even with the other two terms of the conjunction on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  hasEntitlement: vi.fn(async () => true),
  svc: {
    listBlocksForUser: vi.fn(),
    listBlocksForOrg: vi.fn(),
    listBlocksForPartner: vi.fn(),
    listUserBlocksForPartnerAdmin: vi.fn(),
    confirmBlock: vi.fn(),
    retractBlock: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: '11111111-1111-4111-8111-111111111111',
      orgId: null,
      user: { id: '22222222-2222-4222-8222-222222222222', email: 'a@example.com' },
      principal: { kind: 'user_session' },
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../services/wisp/memoryService', () => ({ ...h.svc, MemoryServiceError: class extends Error {} }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));

import { wispEnabled } from '../../config/env';
import { wispMemoryRoutes } from './memory';

const app = new Hono().route('/wisp/memory', wispMemoryRoutes);
const BLOCK = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

describe('wisp memory routes with BREEZE_WISP_ENABLED unset (real wispEnabled)', () => {
  beforeEach(() => {
    h.hasEntitlement.mockReset();
    h.hasEntitlement.mockResolvedValue(true);
    vi.stubEnv('IS_HOSTED', 'true');
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    vi.stubEnv('BREEZE_WISP_ENABLED', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is off, and every route is 404 { error: not_found } without reaching the service', async () => {
    expect(wispEnabled()).toBe(false);
    for (const [path, init] of [
      ['/wisp/memory?scope=mine', undefined],
      ['/wisp/memory?scope=partner', undefined],
      [`/wisp/memory/users/${USER}`, undefined],
      [`/wisp/memory/${BLOCK}/confirm`, { method: 'POST' }],
      [`/wisp/memory/${BLOCK}/retract`, { method: 'POST' }],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(['IS_HOSTED', 'BREEZE_AI_AGENTS_ENABLED', 'BREEZE_WISP_ENABLED'])(
    'each term of the conjunction is required: %s off (other two on) ⇒ 404',
    async (term) => {
      vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
      vi.stubEnv(term, 'false');
      expect(wispEnabled()).toBe(false);
      const res = await app.request('/wisp/memory?scope=mine');
      expect(res.status).toBe(404);
      for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it('flag off wins over a missing entitlement: 404, never 403, and the resolver is not consulted', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const res = await app.request('/wisp/memory?scope=mine');
    expect(res.status).toBe(404);
    expect(h.hasEntitlement).not.toHaveBeenCalled();
  });

  it('control: the same request reaches the service once the flag is on', async () => {
    vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
    h.svc.listBlocksForUser.mockResolvedValue([]);
    expect(wispEnabled()).toBe(true);
    const res = await app.request('/wisp/memory?scope=mine');
    expect(res.status).toBe(200);
    expect(h.svc.listBlocksForUser).toHaveBeenCalledTimes(1);
  });
});
