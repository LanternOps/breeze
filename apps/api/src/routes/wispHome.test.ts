/**
 * Wisp W08 Task 7 — GET /wisp/home. Hub gates are W02's (wisp.test.ts); this
 * pins grant selection, ownership (another user's grant is 404), the paused
 * grant, and the payload composition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  listGrants: vi.fn(),
  getOrCreateThread: vi.fn(),
  threadPayload: vi.fn(),
  ceilingOf: vi.fn(),
  buildHomeSections: vi.fn(),
}));

vi.mock('../services/wisp/grants', () => ({ listGrants: h.listGrants }));
vi.mock('../services/wisp/threads', () => ({ getOrCreateThread: h.getOrCreateThread }));
vi.mock('../services/wisp/home', () => ({ buildHomeSections: h.buildHomeSections }));
vi.mock('./wispThreads', () => ({
  threadPayload: h.threadPayload,
  ceilingOf: h.ceilingOf,
  ceilingRefusal: (c: { json: (b: unknown, s: number) => Response }, reason: string) =>
    c.json({ code: reason === 'corrupt' ? 'grant_corrupt' : 'grant_inactive' }, reason === 'corrupt' ? 500 : 409),
}));

const { wispHomeRoutes } = await import('./wispHome');

const PARTNER = '11111111-1111-4111-8111-111111111111';
const G_ACTIVE = '22222222-2222-4222-8222-222222222222';
const G_PAUSED = '33333333-3333-4333-8333-333333333333';
const G_ORG = '44444444-4444-4444-8444-444444444444';
const auth = { user: { id: 'u1' }, partnerId: PARTNER, scope: 'partner' };
const future = new Date(Date.now() + 86_400_000);
const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id, partnerId: PARTNER, orgId: null, grantorUserId: 'u1', status: 'active', pausedReason: null,
  currentRevisionId: 'r1', expiresAt: future, budgetCentsPerDay: 100, floorTickMinutes: 60, ...over,
});
const thread = { id: 'th1', grantId: G_ACTIVE, partnerId: PARTNER };
const base = { thread: { id: 'th1' }, focusOrgName: null, grant: { id: G_ACTIVE }, wideningAvailable: false };
const sections = { brief: null, needsYou: [], activity: { items: [], nextCursor: null }, current: null, links: [], partner: { enabled: true } };

function get(path: string) {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth' as never, auth as never); await next(); });
  a.route('/home', wispHomeRoutes);
  return a.request(path);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listGrants.mockResolvedValue([grant(G_ACTIVE)]);
  h.getOrCreateThread.mockResolvedValue(thread);
  h.threadPayload.mockResolvedValue(base);
  h.ceilingOf.mockResolvedValue({ ok: true, ceiling: { grantId: G_ACTIVE } });
  h.buildHomeSections.mockResolvedValue(sections);
});

describe('GET /wisp/home', () => {
  it('composes the thread payload and the home sections for the caller\'s own grant', async () => {
    const res = await get(`/home?grantId=${G_ACTIVE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ...base, ...sections } });
    expect(h.listGrants).toHaveBeenCalledWith({ auth, view: 'mine' });
    expect(h.buildHomeSections).toHaveBeenCalledWith({
      auth, partnerId: PARTNER, grantId: G_ACTIVE, grantorUserId: 'u1', threadId: 'th1', ceiling: { grantId: G_ACTIVE },
    });
  });

  it('another user\'s grant (not in "mine") is an existence-neutral 404', async () => {
    const res = await get(`/home?grantId=${G_PAUSED}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
    expect(h.getOrCreateThread).not.toHaveBeenCalled();
  });

  it('a revoked or expired grant is 404 by id', async () => {
    h.listGrants.mockResolvedValue([grant(G_ACTIVE, { status: 'revoked' }), grant(G_PAUSED, { expiresAt: new Date(Date.now() - 1000) })]);
    expect((await get(`/home?grantId=${G_ACTIVE}`)).status).toBe(404);
    expect((await get(`/home?grantId=${G_PAUSED}`)).status).toBe(404);
  });

  it('without grantId: the active grant first, partner-wide before org-scoped', async () => {
    h.listGrants.mockResolvedValue([grant(G_PAUSED, { status: 'paused' }), grant(G_ORG, { orgId: 'o1' }), grant(G_ACTIVE)]);
    await get('/home');
    expect(h.getOrCreateThread).toHaveBeenCalledWith(G_ACTIVE);
  });

  it('without grantId and only a paused grant: its home, with no ceiling-bound sections', async () => {
    h.listGrants.mockResolvedValue([grant(G_PAUSED, { status: 'paused', pausedReason: 'user_paused' })]);
    h.ceilingOf.mockResolvedValue({ ok: false, reason: 'inactive' });
    const res = await get('/home');
    expect(res.status).toBe(200);
    expect(h.buildHomeSections).toHaveBeenCalledWith(expect.objectContaining({ grantId: G_PAUSED, ceiling: null }));
  });

  it('no usable grant → 404 no_grant (the page shows the start card)', async () => {
    h.listGrants.mockResolvedValue([grant(G_ACTIVE, { status: 'revoked' })]);
    const res = await get('/home');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'no_grant' });
  });

  it('a corrupt ceiling pin is the thread route\'s 500, not a quiet empty home', async () => {
    h.ceilingOf.mockResolvedValue({ ok: false, reason: 'corrupt' });
    expect((await get(`/home?grantId=${G_ACTIVE}`)).status).toBe(500);
    expect(h.buildHomeSections).not.toHaveBeenCalled();
  });

  it('400 on a malformed grantId', async () => {
    expect((await get('/home?grantId=nope')).status).toBe(400);
  });
});
