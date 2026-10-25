/**
 * Wisp W08 Task 4 — GET/POST/DELETE /wisp/thread/:id/links. The hub gates
 * (flag, partner scope, ai_sessions:use, entitlement) are W02's and covered by
 * wisp.test.ts; this file pins ownership, validation, refusal mapping, audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => {
  class ThreadLinkError extends Error {
    constructor(public readonly code: string) { super(code); }
  }
  return {
    ThreadLinkError,
    loadOwnThread: vi.fn(),
    ceilingOf: vi.fn(),
    addLink: vi.fn(),
    removeLink: vi.fn(),
    listLinks: vi.fn(),
    writeRouteAudit: vi.fn(),
  };
});

vi.mock('./wispThreads', () => ({
  loadOwnThread: h.loadOwnThread,
  ceilingOf: h.ceilingOf,
  ceilingRefusal: (c: { json: (b: unknown, s: number) => Response }, reason: string) =>
    c.json({ code: reason === 'corrupt' ? 'grant_corrupt' : 'grant_inactive' }, reason === 'corrupt' ? 500 : 409),
}));
vi.mock('../services/wisp/threadLinks', () => ({
  ThreadLinkError: h.ThreadLinkError,
  THREAD_LINK_REFUSAL_STATUS: { not_found: 404, forbidden: 403, outside_ceiling: 403, outside_token_scope: 403, link_limit: 409 },
  addLink: h.addLink,
  removeLink: h.removeLink,
  listLinks: h.listLinks,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));

const { wispThreadLinkRoutes } = await import('./wispThreadLinks');

const PARTNER = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const TICKET = '44444444-4444-4444-8444-444444444444';
const auth = { user: { id: 'u1' }, partnerId: PARTNER, scope: 'partner' };
const own = { thread: { id: THREAD, partnerId: PARTNER }, grant: { id: 'g1', currentRevisionId: 'r1' } };
const ceiling = { grantId: 'g1', partnerId: PARTNER };
const link = { id: LINK, ref: { kind: 'ticket', id: TICKET, orgId: 'o1' }, label: '#1 Printer', status: 'open', href: `/tickets/${TICKET}`, addedBy: 'user', createdAt: '2027-01-05T00:00:00.000Z' };

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth' as never, auth as never); await next(); });
  a.route('/thread', wispThreadLinkRoutes);
  return a;
}
const req = (method: string, path: string, body?: unknown) => app().request(path, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.loadOwnThread.mockResolvedValue(own);
  h.ceilingOf.mockResolvedValue({ ok: true, ceiling });
});

describe('GET /thread/:id/links', () => {
  it('returns the re-resolved links of the caller\'s own thread', async () => {
    h.listLinks.mockResolvedValue([link]);
    const res = await req('GET', `/thread/${THREAD}/links`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { links: [link] } });
    expect(h.listLinks).toHaveBeenCalledWith({ auth, ceiling }, THREAD);
  });

  it('another user\'s thread (or a bad id) is the same existence-neutral 404', async () => {
    h.loadOwnThread.mockResolvedValue(null);
    const res = await req('GET', `/thread/${THREAD}/links`);
    expect(res.status).toBe(404);
    expect(h.listLinks).not.toHaveBeenCalled();
  });

  it('an inactive grant is 409 and lists nothing', async () => {
    h.ceilingOf.mockResolvedValue({ ok: false, reason: 'inactive' });
    expect((await req('GET', `/thread/${THREAD}/links`)).status).toBe(409);
    expect(h.listLinks).not.toHaveBeenCalled();
  });
});

describe('POST /thread/:id/links', () => {
  it('201 with the link; audited with thread, kind and entity', async () => {
    h.addLink.mockResolvedValue(link);
    const res = await req('POST', `/thread/${THREAD}/links`, { kind: 'ticket', id: TICKET });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { link } });
    expect(h.addLink).toHaveBeenCalledWith({ auth, ceiling }, THREAD, { kind: 'ticket', id: TICKET, orgId: undefined }, { addedByGrantId: null });
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.thread.link_added',
      orgId: 'o1',
      partnerId: PARTNER,
      details: { threadId: THREAD, kind: 'ticket', entityId: TICKET },
    }));
  });

  it('400 on a schema failure (unknown kind, extra member), nothing written', async () => {
    expect((await req('POST', `/thread/${THREAD}/links`, { kind: 'incident', id: TICKET })).status).toBe(400);
    expect((await req('POST', `/thread/${THREAD}/links`, { kind: 'ticket', id: TICKET, partnerId: PARTNER })).status).toBe(400);
    expect(h.addLink).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404], ['forbidden', 403], ['outside_ceiling', 403], ['outside_token_scope', 403], ['link_limit', 409],
  ])('refusal %s → %i, not audited', async (code, status) => {
    h.addLink.mockRejectedValue(new h.ThreadLinkError(code));
    const res = await req('POST', `/thread/${THREAD}/links`, { kind: 'ticket', id: TICKET });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('another user\'s thread → 404 before any resolve', async () => {
    h.loadOwnThread.mockResolvedValue(null);
    expect((await req('POST', `/thread/${THREAD}/links`, { kind: 'ticket', id: TICKET })).status).toBe(404);
    expect(h.addLink).not.toHaveBeenCalled();
  });
});

describe('DELETE /thread/:id/links/:linkId', () => {
  it('204 and audited', async () => {
    h.removeLink.mockResolvedValue({ id: LINK, orgId: 'o1', entityKind: 'ticket', entityId: TICKET });
    const res = await req('DELETE', `/thread/${THREAD}/links/${LINK}`);
    expect(res.status).toBe(204);
    expect(h.removeLink).toHaveBeenCalledWith(PARTNER, THREAD, LINK);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.thread.link_removed',
      details: { threadId: THREAD, kind: 'ticket', entityId: TICKET },
    }));
  });

  it('works while the grant is paused (no ceiling needed to remove your own link)', async () => {
    h.ceilingOf.mockResolvedValue({ ok: false, reason: 'inactive' });
    h.removeLink.mockResolvedValue({ id: LINK, orgId: null, entityKind: 'user', entityId: TICKET });
    expect((await req('DELETE', `/thread/${THREAD}/links/${LINK}`)).status).toBe(204);
  });

  it('404 for a missing link or a malformed link id; nothing audited', async () => {
    h.removeLink.mockResolvedValue(null);
    expect((await req('DELETE', `/thread/${THREAD}/links/${LINK}`)).status).toBe(404);
    expect((await req('DELETE', `/thread/${THREAD}/links/nope`)).status).toBe(404);
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });
});
