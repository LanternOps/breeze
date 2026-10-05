import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Tx } from './types';
const m = vi.hoisted(() => ({ rows: [] as Array<{ enabled: boolean }>, scope: 'partner', elevated: vi.fn() }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) },
  getCurrentDbAccessContext: () => ({ scope: m.scope }),
}));
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: async (fn: () => Promise<unknown>) => {
  m.elevated(); return fn();
} }));
import { db } from '../../db';
import { isAutopayEnabledForPartner, requireAutopayEnabled } from './autopayGate';
const partnerId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { m.rows = []; m.scope = 'partner'; m.elevated.mockClear(); });
describe('autopay rollout gate', () => {
  it.each([{ rows: [] }, { rows: [{ enabled: false }] }])('fails closed for %j', async ({ rows }) => {
    m.rows = rows; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
  });
  it('reads fresh state on each call', async () => {
    m.rows = [{ enabled: true }]; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(true);
    m.rows = [{ enabled: false }]; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
  });
  it('uses an escaped ambient handle for organization callers, never their held tx', async () => {
    m.scope = 'organization'; m.rows = [{ enabled: true }];
    const tx = { select: vi.fn(() => { throw new Error('old transaction escaped'); }) } as unknown as Tx;
    expect(await isAutopayEnabledForPartner(tx, partnerId)).toBe(true);
    expect(m.elevated).toHaveBeenCalledOnce();
  });
  it('returns the binding machine code and only calls the handler when on', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { partnerId } as never); await next(); });
    app.get('/protected', requireAutopayEnabled(), c => c.json({ reached: true }));
    const off = await app.request('/protected');
    expect(off.status).toBe(404); expect(await off.json()).toMatchObject({ code: 'autopay_not_enabled' });
    m.rows = [{ enabled: true }]; expect((await app.request('/protected')).status).toBe(200);
  });
});
