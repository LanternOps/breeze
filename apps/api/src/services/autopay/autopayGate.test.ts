import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Tx } from './types';
type Row = { autopayEnabled: boolean; status: string; deletedAt: Date | null };
const m = vi.hoisted(() => ({ rows: [] as Row[], scope: 'partner', elevated: vi.fn() }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) },
  getCurrentDbAccessContext: () => ({ scope: m.scope }),
}));
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: async (fn: () => Promise<unknown>) => {
  m.elevated(); return fn();
} }));
import { db } from '../../db';
import { organizations } from '../../db/schema';
import {
  autopayPartnerLiveCondition, hasLiveAutopayPartner, isAutopayEnabledForPartner, isAutopayPartnerLive, requireAutopayEnabled,
} from './autopayGate';
const partnerId = '11111111-1111-4111-8111-111111111111';
const live: Row = { autopayEnabled: true, status: 'active', deletedAt: null };
beforeEach(() => { m.rows = []; m.scope = 'partner'; m.elevated.mockClear(); });
describe('autopay rollout gate', () => {
  it.each([{ rows: [] }, { rows: [{ ...live, autopayEnabled: false }] }])('fails closed for %j', async ({ rows }) => {
    m.rows = rows; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
  });
  it('reads fresh state on each call', async () => {
    m.rows = [live]; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(true);
    m.rows = [{ ...live, autopayEnabled: false }]; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
  });
  it('uses an escaped ambient handle for organization callers, never their held tx', async () => {
    m.scope = 'organization'; m.rows = [live];
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
    m.rows = [live]; expect((await app.request('/protected')).status).toBe(200);
  });
});

describe('autopay runs only for an active partner', () => {
  it.each(['pending', 'suspended', 'churned', 'offboarding'])('a %s partner is not live even with the rollout flag on', async status => {
    m.rows = [{ ...live, status }];
    expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
    expect(await hasLiveAutopayPartner(db as Tx, partnerId)).toBe(false);
    expect(isAutopayPartnerLive({ status, deletedAt: null })).toBe(false);
  });
  it('a soft-deleted partner is not live even while still marked active', async () => {
    m.rows = [{ ...live, deletedAt: new Date() }];
    expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
    expect(await hasLiveAutopayPartner(db as Tx, partnerId)).toBe(false);
  });
  it('partner liveness does not depend on the rollout flag', async () => {
    m.rows = [{ ...live, autopayEnabled: false }];
    expect(await hasLiveAutopayPartner(db as Tx, partnerId)).toBe(true);
    m.rows = [];
    expect(await hasLiveAutopayPartner(db as Tx, partnerId)).toBe(false);
  });
  it('the middleware refuses an active-flag partner that is suspended', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { partnerId } as never); await next(); });
    app.get('/protected', requireAutopayEnabled(), c => c.json({ reached: true }));
    m.rows = [{ ...live, status: 'suspended' }];
    expect((await app.request('/protected')).status).toBe(404);
  });
  it('the SQL condition carries the same status and deletion bar', () => {
    const { sql, params } = new PgDialect().sqlToQuery(autopayPartnerLiveCondition(organizations.partnerId));
    expect(sql).toMatch(/"autopay_live_partner"\."id" = "organizations"\."partner_id"/);
    expect(sql).toMatch(/"autopay_live_partner"\."status" in \(\$1\)/);
    expect(sql).toMatch(/"autopay_live_partner"\."deleted_at" is null/);
    expect(params).toEqual(['active']);
  });
});
