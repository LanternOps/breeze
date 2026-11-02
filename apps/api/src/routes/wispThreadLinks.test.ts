/**
 * Wisp W08 Task 4 — GET/POST/DELETE /wisp/thread/:id/links. The hub gates
 * (flag, partner scope, ai_sessions:use, entitlement) are W02's and covered by
 * wisp.test.ts; this file pins ownership, validation, refusal mapping, audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => {
  class ThreadLinkError extends Error {
    constructor(public readonly code: string) { super(code); }
  }
  return {
    ThreadLinkError,
    dbRows: [] as unknown[],
    dbWhere: vi.fn(),
    inSystemContext: vi.fn(),
    loadOwnThread: vi.fn(),
    ceilingOf: vi.fn(),
    addLink: vi.fn(),
    removeLink: vi.fn(),
    listWorkingSet: vi.fn(),
    listConcernsForCeiling: vi.fn(),
    resolveEntityRef: vi.fn(),
    neighbourRefs: vi.fn(),
    writeRouteAudit: vi.fn(),
  };
});

vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: (condition: unknown) => {
    h.dbWhere(condition);
    return { limit: async () => h.dbRows };
  } }) }) },
}));
vi.mock('../services/wisp/grantAuthority', () => ({ inSystemContext: h.inSystemContext }));

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
  listWorkingSet: h.listWorkingSet,
}));
vi.mock('../services/wisp/concerns', () => ({ listConcernsForCeiling: h.listConcernsForCeiling }));
vi.mock('../services/wisp/entityRefs', () => ({
  resolveEntityRef: h.resolveEntityRef,
  isResolveFailure: (result: object) => 'reason' in result,
}));
vi.mock('../services/wisp/entityRelations', () => ({ neighbourRefs: h.neighbourRefs }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));

const { wispThreadLinkRoutes } = await import('./wispThreadLinks');

const PARTNER = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const TICKET = '44444444-4444-4444-8444-444444444444';
const auth = { user: { id: 'u1' }, partnerId: PARTNER, scope: 'partner' };
const own = { thread: { id: THREAD, partnerId: PARTNER }, grant: { id: 'g1', currentRevisionId: 'r1' } };
const ceiling = { grantId: 'g1', partnerId: PARTNER };
const link = { id: LINK, ref: { kind: 'ticket', id: TICKET, orgId: 'o1' }, label: '#1 Printer', status: 'open', href: `/tickets/${TICKET}`, source: 'user_pin', lastTouchedAt: '2026-10-24T08:00:00Z', createdAt: '2027-01-05T00:00:00.000Z' };

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
  h.dbRows = [{ kind: link.ref.kind, id: link.ref.id }];
  h.inSystemContext.mockImplementation((fn: () => unknown) => fn());
  h.loadOwnThread.mockResolvedValue(own);
  h.listConcernsForCeiling.mockResolvedValue([]);
  h.ceilingOf.mockResolvedValue({ ok: true, ceiling });
  h.resolveEntityRef.mockReset().mockResolvedValue({
    ref: link.ref, orgId: link.ref.orgId, label: link.label, status: link.status, href: link.href,
  });
  h.neighbourRefs.mockReset().mockResolvedValue([]);
});

describe('GET /thread/:id/links', () => {
  it('returns the re-resolved links of the caller\'s own thread', async () => {
    const concerns = [{ id: 'c1', status: 'open' }];
    h.listConcernsForCeiling.mockResolvedValue(concerns);
    h.listWorkingSet.mockResolvedValue([link]);
    const res = await req('GET', `/thread/${THREAD}/links`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { links: [link] } });
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith(ceiling, { status: ['open', 'snoozed'] });
    expect(h.listWorkingSet).toHaveBeenCalledWith({ auth, ceiling }, THREAD, { concerns });
  });

  it('another user\'s thread (or a bad id) is the same existence-neutral 404', async () => {
    h.loadOwnThread.mockResolvedValue(null);
    const res = await req('GET', `/thread/${THREAD}/links`);
    expect(res.status).toBe(404);
    expect(h.listWorkingSet).not.toHaveBeenCalled();
    expect(h.listConcernsForCeiling).not.toHaveBeenCalled();
  });

  it('an inactive grant is 409 and lists nothing', async () => {
    h.ceilingOf.mockResolvedValue({ ok: false, reason: 'inactive' });
    expect((await req('GET', `/thread/${THREAD}/links`)).status).toBe(409);
    expect(h.listWorkingSet).not.toHaveBeenCalled();
    expect(h.listConcernsForCeiling).not.toHaveBeenCalled();
  });
});

describe('POST /thread/:id/links', () => {
  it('201 with the link; audited with thread, kind and entity', async () => {
    h.addLink.mockResolvedValue(link);
    const res = await req('POST', `/thread/${THREAD}/links`, { kind: 'ticket', id: TICKET });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { link } });
    expect(h.addLink).toHaveBeenCalledWith({ auth, ceiling }, THREAD, { kind: 'ticket', id: TICKET, orgId: undefined }, { source: 'user_pin', addedByGrantId: null });
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
    const malformed = await req('DELETE', `/thread/${THREAD}/links/nope`);
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'Link not found', code: 'not_found' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });
});


describe('POST /thread/:id/links/:linkId/pin', () => {
  it.each(['forbidden', 'outside_ceiling', 'outside_token_scope'])(
    'returns the specific 403 for a stored row omitted from listWorkingSet as %s', async (code) => {
      h.listWorkingSet.mockResolvedValue([]);
      h.addLink.mockRejectedValue(new h.ThreadLinkError(code));
      const res = await req('POST', `/thread/${THREAD}/links/${LINK}/pin`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code });
      expect(h.listWorkingSet).not.toHaveBeenCalled();
      expect(h.addLink).toHaveBeenCalledWith({ auth, ceiling }, THREAD, { kind: link.ref.kind, id: link.ref.id }, { source: 'user_pin', addedByGrantId: null });
      expect(h.writeRouteAudit).not.toHaveBeenCalled();
    },
  );
  it('pin promotes an auto link and audits the server-resolved ref', async () => {
    h.listWorkingSet.mockResolvedValue([{ ...link, source: 'auto' }]);
    h.addLink.mockResolvedValue(link);
    const res = await req('POST', `/thread/${THREAD}/links/${LINK}/pin`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { link } });
    expect(h.listWorkingSet).not.toHaveBeenCalled();
    expect(h.inSystemContext).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(h.dbWhere.mock.calls[0]![0]);
    expect(query.sql).toContain('"wisp_thread_links"."partner_id" =');
    expect(query.sql).toContain('"wisp_thread_links"."thread_id" =');
    expect(query.sql).toContain('"wisp_thread_links"."id" =');
    expect(query.params).toEqual([LINK, THREAD, PARTNER]);
    expect(h.addLink).toHaveBeenCalledWith({ auth, ceiling }, THREAD, { kind: link.ref.kind, id: link.ref.id }, { source: 'user_pin', addedByGrantId: null });
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.thread.link_added', details: { threadId: THREAD, kind: 'ticket', entityId: TICKET, source: 'user_pin' },
    }));
  });

  it.each(['missing', 'malformed', 'foreign thread', 'inactive', 'cap', 'outside_ceiling'])('refuses %s without auditing', async (reason) => {
    h.dbRows = reason === 'missing' ? [] : [{ kind: link.ref.kind, id: link.ref.id }];
    h.listWorkingSet.mockResolvedValue(reason === 'missing' ? [] : [{ ...link, source: 'auto' }]);
    if (reason === 'foreign thread') h.loadOwnThread.mockResolvedValue(null);
    if (reason === 'inactive') h.ceilingOf.mockResolvedValue({ ok: false, reason: 'inactive' });
    if (reason === 'cap' || reason === 'outside_ceiling') h.addLink.mockRejectedValue(new h.ThreadLinkError(reason === 'cap' ? 'link_limit' : 'outside_ceiling'));
    const res = await req('POST', `/thread/${THREAD}/links/${reason === 'malformed' ? 'bad' : LINK}/pin`);
    expect(res.status).toBe(reason === 'inactive' || reason === 'cap' ? 409 : reason === 'outside_ceiling' ? 403 : 404);
    if (reason === 'missing' || reason === 'malformed') {
      expect(await res.json()).toEqual({ error: 'Link not found', code: 'not_found' });
    }
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
    if (!['cap', 'outside_ceiling'].includes(reason)) expect(h.addLink).not.toHaveBeenCalled();
    if (['malformed', 'foreign thread', 'inactive'].includes(reason)) {
      expect(h.dbWhere).not.toHaveBeenCalled();
      expect(h.inSystemContext).not.toHaveBeenCalled();
    }
  });
});

it('GET returns derived concern subjects with null ids', async () => {
  const concern = { ...link, id: null, source: 'concern' };
  h.listWorkingSet.mockResolvedValue([concern]);
  const res = await req('GET', `/thread/${THREAD}/links`);
  expect(await res.json()).toEqual({ data: { links: [concern] } });
});


describe('GET /thread/:id/links/neighbours', () => {
  const path = `/thread/${THREAD}/links/neighbours?kind=ticket&id=${TICKET}`;
  const deviceRef = { kind: 'device', id: '55555555-5555-4555-8555-555555555555' };
  const orgRef = { kind: 'organization', id: '66666666-6666-4666-8666-666666666666' };
  const device = {
    ref: { ...deviceRef, orgId: '77777777-7777-4777-8777-777777777777' },
    orgId: '77777777-7777-4777-8777-777777777777',
    label: 'Freshly resolved device', status: 'online', href: `/devices/${deviceRef.id}`,
  };

  it('neighbours omit an org the caller cannot read', async () => {
    h.neighbourRefs.mockResolvedValue([deviceRef, orgRef]);
    h.resolveEntityRef
      .mockResolvedValueOnce({ ref: link.ref })
      .mockResolvedValueOnce(device)
      .mockResolvedValueOnce({ reason: 'forbidden' });
    const res = await req('GET', path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { links: [{
      id: null, ref: device.ref, label: device.label, status: device.status, href: device.href,
      source: 'auto', lastTouchedAt: expect.any(String), createdAt: expect.any(String),
    }] } });
    expect(h.neighbourRefs).toHaveBeenCalledWith(PARTNER, { kind: 'ticket', id: TICKET });
    expect(h.resolveEntityRef).toHaveBeenNthCalledWith(1, { auth, ceiling }, { kind: 'ticket', id: TICKET });
    expect(h.resolveEntityRef).toHaveBeenNthCalledWith(2, { auth, ceiling }, deviceRef);
    expect(h.resolveEntityRef).toHaveBeenNthCalledWith(3, { auth, ceiling }, orgRef);
    expect(h.resolveEntityRef.mock.invocationCallOrder[0]).toBeLessThan(h.neighbourRefs.mock.invocationCallOrder[0]!);
    expect(h.addLink).not.toHaveBeenCalled();
    expect(h.removeLink).not.toHaveBeenCalled();
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'forbidden', 'outside_ceiling', 'outside_token_scope'])(
    'neighbours 404 when the subject is refused (%s)', async (reason) => {
      h.resolveEntityRef.mockResolvedValue({ reason });
      const res = await req('GET', path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Link not found', code: 'not_found' });
      expect(h.neighbourRefs).not.toHaveBeenCalled();
      expect(h.writeRouteAudit).not.toHaveBeenCalled();
    },
  );

  it('neighbours cap at 8', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({
      kind: 'device', id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
    }));
    h.neighbourRefs.mockResolvedValue(refs);
    h.resolveEntityRef.mockImplementation(async (_ctx, ref) => ({ ...device, ref: { ...ref, orgId: device.orgId } }));
    const res = await req('GET', path);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.links).toHaveLength(8);
    expect(body.data.links.map((item: typeof link) => item.ref.id)).toEqual(refs.slice(0, 8).map((ref) => ref.id));
    expect(body.data.links.every((item: typeof link) => item.id === null && item.source === 'auto')).toBe(true);
  });

  it('returns an empty list for a subject with no neighbours', async () => {
    const res = await req('GET', path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { links: [] } });
  });

  it.each(['kind=incident&id=' + TICKET, 'kind=ticket&id=bad', 'kind=ticket', 'id=' + TICKET])(
    'rejects invalid neighbours query %s before any relation read', async (query) => {
      expect((await req('GET', `/thread/${THREAD}/links/neighbours?${query}`)).status).toBe(400);
      expect(h.resolveEntityRef).not.toHaveBeenCalled();
      expect(h.neighbourRefs).not.toHaveBeenCalled();
    },
  );

  it('refuses another user\'s thread before resolving the subject', async () => {
    h.loadOwnThread.mockResolvedValue(null);
    expect((await req('GET', path)).status).toBe(404);
    expect(h.resolveEntityRef).not.toHaveBeenCalled();
    expect(h.neighbourRefs).not.toHaveBeenCalled();
  });

  it('refuses an inactive grant before resolving the subject', async () => {
    h.ceilingOf.mockResolvedValue({ ok: false, reason: 'inactive' });
    expect((await req('GET', path)).status).toBe(409);
    expect(h.resolveEntityRef).not.toHaveBeenCalled();
    expect(h.neighbourRefs).not.toHaveBeenCalled();
  });
});
