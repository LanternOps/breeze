// apps/api/src/routes/portal/trustPageLink.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbm = vi.hoisted(() => ({ rows: [] as unknown[][], contexts: [] as string[], insert: vi.fn() }));
vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'limit']) c[m] = vi.fn(() => c);
    c.then = (r: (v: unknown) => unknown) => Promise.resolve(dbm.rows.shift() ?? []).then(r);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()), insert: dbm.insert },
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T,>(fn: () => T): T => { dbm.contexts.push('system'); return fn(); },
  };
});
const trustMode = vi.hoisted(() => ({ value: 'enforce' as 'off' | 'shadow' | 'enforce' }));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: () => trustMode.value }));

import { portalTrustPageLinkRoutes } from './trustPageLink';

const ORG = '11111111-1111-4111-8111-111111111111';
const app = new Hono();
app.use('*', async (c, next) => { c.set('portalAuth' as never, { user: { id: 'pu1', orgId: ORG } } as never); await next(); });
app.route('/', portalTrustPageLinkRoutes);
const get = async () => { const res = await app.request('/trust-page'); return { status: res.status, body: await res.json() }; };

const page = (over: Record<string, unknown> = {}) => ({ publishedAt: new Date('2026-10-01T00:00:00Z'), isPartnerHome: false, partnerId: 'p1', orgSlug: 'acme', ...over });

describe('portal GET /trust-page (dashboard link)', () => {
  beforeEach(() => { dbm.rows = []; dbm.contexts = []; trustMode.value = 'enforce'; vi.clearAllMocks(); });

  it('no trust page → null, and nothing is created', async () => {
    dbm.rows = [[]];
    expect(await get()).toEqual({ status: 200, body: { data: { publicPath: null } } });
    expect(dbm.insert).not.toHaveBeenCalled();
    expect(dbm.contexts).toEqual([]); // the partner is never read for an org with no page
  });

  it('an unpublished page → null', async () => {
    dbm.rows = [[page({ publishedAt: null })]];
    expect((await get()).body).toEqual({ data: { publicPath: null } });
    expect(dbm.contexts).toEqual([]);
  });

  it('a published page of a trusted partner → its portal-relative trust path', async () => {
    dbm.rows = [[page()], [{ slug: 'nw', trustState: 'trusted' }]];
    expect((await get()).body).toEqual({ data: { publicPath: '/trust/nw/acme' } });
    // Partners are not readable in the portal's org context; the slug read is the one system escalation.
    expect(dbm.contexts).toEqual(['system']);
  });

  it('a published partner-home page links the partner path', async () => {
    dbm.rows = [[page({ isPartnerHome: true })], [{ slug: 'nw', trustState: 'trusted' }]];
    expect((await get()).body).toEqual({ data: { publicPath: '/trust/nw' } });
  });

  it.each(['restricted', 'probation'])('a %s partner → null (the public page would 404)', async (trustState) => {
    dbm.rows = [[page()], [{ slug: 'nw', trustState }]];
    expect((await get()).body).toEqual({ data: { publicPath: null } });
  });

  it('trust mode off: a probation partner still links (publish is allowed)', async () => {
    trustMode.value = 'off';
    dbm.rows = [[page()], [{ slug: 'nw', trustState: 'probation' }]];
    expect((await get()).body).toEqual({ data: { publicPath: '/trust/nw/acme' } });
  });

  it.each([
    ['an invalid org slug', 'Acme Dental', 'nw'],
    ['a reserved partner slug', 'acme', 'preview'],
  ])('%s → null', async (_label, orgSlug, partnerSlug) => {
    dbm.rows = [[page({ orgSlug })], [{ slug: partnerSlug, trustState: 'trusted' }]];
    expect((await get()).body).toEqual({ data: { publicPath: null } });
  });

  it('sends a private, revalidated cache header', async () => {
    dbm.rows = [[]];
    const res = await app.request('/trust-page');
    expect(res.headers.get('cache-control')).toMatch(/private/);
  });
});
