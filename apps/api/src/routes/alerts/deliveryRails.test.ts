import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], authenticated: true, read: true, auth: {} as any }));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  requireMfa: () => async (_c: any, next: any) => next(),
  requireScope: () => async (c: any, next: any) => {
    if (!state.authenticated) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', state.auth); await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    if (!state.read) return c.json({ error: 'Forbidden' }, 403); await next();
  },
}));
vi.mock('../../db', () => ({ db: { select: () => {
  // selectNotificationChannelsWithConfig (#6379) chains .leftJoin() and
  // .$dynamic() before the terminal (awaited directly, since no .limit() is
  // passed for this rail's unbounded read).
  const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: () => q,
    leftJoin: () => q, $dynamic: () => q,
    then: (ok: any, bad: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, bad) }; return q;
} } }));
vi.mock('../../services/delivery/escalationExecution', () => ({ listEscalationUsers: vi.fn(async () => []) }));
import { listEscalationUsers } from '../../services/delivery/escalationExecution';
import { deliveryRailsRoutes } from './deliveryRails';
const ORG = '10000000-0000-4000-8000-000000000001', PARTNER = '20000000-0000-4000-8000-000000000001';
const app = new Hono().route('/alerts', deliveryRailsRoutes);
beforeEach(() => {
  vi.clearAllMocks();
  state.rows.length = 0; state.authenticated = true; state.read = true;
  state.auth = { scope: 'organization', orgId: ORG, partnerId: PARTNER, canAccessOrg: (id: string) => id === ORG };
});
it('exposes only the inherited channel DTO through HTTP', async () => {
  state.rows.push([{ partnerId: PARTNER }], [], [{ id: 'ch', name: 'NOC', type: 'slack', enabled: true }]);
  const res = await app.request('/alerts/delivery/rails?rail=channels');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: [], inherited: [{ id: 'ch', name: 'NOC', type: 'slack', enabled: true, inherited: true }] });
});
it('rejects a foreign org and partner user selection by an org token', async () => {
  expect((await app.request(`/alerts/delivery/rails?rail=routing&orgId=${PARTNER}`)).status).toBe(403);
  expect((await app.request('/alerts/delivery/rails?rail=users&ownerScope=partner')).status).toBe(403);
});
it('returns a safe 500 on a failed rail read', async () => {
  const { db } = await import('../../db');
  vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('private db detail'); });
  const res = await app.request('/alerts/delivery/rails?rail=routing');
  expect(res.status).toBe(500); expect(await res.text()).not.toContain('private db detail');
});

it.each(['organization', 'partner', 'system'])('passes caller scope to the users rail for %s tokens', async scope => {
  state.auth.scope = scope;
  state.rows.push([{ partnerId: PARTNER }]);
  const res = await app.request(`/alerts/delivery/rails?rail=users&orgId=${ORG}`);
  expect(res.status).toBe(200);
  expect(listEscalationUsers).toHaveBeenCalledWith({ orgId: ORG, partnerId: null }, undefined,
    { includePartnerUsers: scope !== 'organization' });
});
