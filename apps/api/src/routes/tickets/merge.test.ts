/**
 * #8972 W1 Task 1.5: GET /tickets/:id/merge-preview and POST /tickets/:id/merge.
 * The router is mounted alone (the hub's other routers are not under test);
 * the services are mocked at the module boundary.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authRef, permsRef, mfaRef, getScopedTicketOr404Mock, deviceInSiteScopeMock, mergeTicketsMock, previewMergeMock,
  dbWrites,
} = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    } as Record<string, unknown> | null,
  },
  permsRef: { current: new Set<string>(['tickets:write']) },
  mfaRef: { current: true },
  getScopedTicketOr404Mock: vi.fn(),
  deviceInSiteScopeMock: vi.fn(async () => true),
  mergeTicketsMock: vi.fn(),
  previewMergeMock: vi.fn(),
  dbWrites: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = authRef.current;
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope as string)) return c.json({ error: 'Forbidden' }, 403);
    c.set('auth', auth);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!permsRef.current.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (!mfaRef.current) return c.json({ error: 'MFA required' }, 403);
    await next();
  },
}));

vi.mock('./tickets', () => ({
  getScopedTicketOr404: getScopedTicketOr404Mock,
  actorFrom: (c: any) => ({ kind: 'user', userId: c.get('auth').user.id, name: c.get('auth').user.name }),
  handleServiceError: async (c: any, err: unknown) => {
    const { ticketMergedResponse } = await import('../../services/ticketMerge/errors');
    const r = ticketMergedResponse(c, err);
    if (r) return r;
    throw err;
  },
}));
vi.mock('./siteScope', () => ({ deviceInSiteScope: deviceInSiteScopeMock }));
vi.mock('../../services/ticketMerge/execute', () => ({ mergeTickets: mergeTicketsMock }));
vi.mock('../../services/ticketMerge/preview', () => ({ previewMerge: previewMergeMock }));
vi.mock('../../db', () => ({
  db: new Proxy({}, { get: (_t, prop) => { dbWrites(String(prop)); return () => { throw new Error(`db.${String(prop)} called`); }; } }),
}));

import { ticketMergeRoutes } from './merge';
import { MergeRefusedError } from '../../services/ticketMerge/errors';

const SRC = '3f2f1d8e-1111-4222-8333-444455556666';
const DST = '3f2f1d8e-1111-4222-8333-777788889999';
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, orgId: 'org-1', partnerId: 'p-1', status: 'open', deviceId: null, createdAt: new Date('2026-01-02'), ...over,
});

function app() {
  const a = new Hono();
  a.route('/tickets', ticketMergeRoutes);
  a.onError((err, c) => c.json({ error: String(err) }, 500));
  return a;
}
const post = (body: unknown, id = SRC) => app().request(`/tickets/${id}/merge`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const preview = (into = DST, id = SRC) => app().request(`/tickets/${id}/merge-preview?into=${into}`);

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = {
    scope: 'partner', user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    partnerId: 'p-1', orgId: null, accessibleOrgIds: ['org-1'], canAccessOrg: () => true,
  };
  permsRef.current = new Set(['tickets:write']);
  mfaRef.current = true;
  getScopedTicketOr404Mock.mockImplementation(async (_auth: unknown, id: string) => row(id));
});

describe('POST /tickets/:id/merge (#8972 W1)', () => {
  it('401 without auth', async () => {
    authRef.current = null;
    expect((await post({ intoTicketId: DST })).status).toBe(401);
  });

  it('403 without tickets:write', async () => {
    permsRef.current = new Set(['tickets:read']);
    expect((await post({ intoTicketId: DST })).status).toBe(403);
    expect(mergeTicketsMock).not.toHaveBeenCalled();
  });

  it('requires MFA (requireMfa, as move-org)', async () => {
    mfaRef.current = false;
    expect((await post({ intoTicketId: DST })).status).toBe(403);
    expect(mergeTicketsMock).not.toHaveBeenCalled();
  });

  it('an org-scope token can merge inside its own org', async () => {
    authRef.current = { ...authRef.current!, scope: 'organization', orgId: 'org-1', partnerId: null };
    mergeTicketsMock.mockResolvedValue({ survivorId: DST, counts: {}, droppedLinks: [], retainedExternalRefIds: [], notifyRequester: false });
    const res = await post({ intoTicketId: DST });
    expect(res.status).toBe(200);
  });

  it('404 when either ticket is outside the caller\'s scope', async () => {
    getScopedTicketOr404Mock.mockImplementation(async (_a: unknown, id: string) => (id === DST ? null : row(id)));
    expect((await post({ intoTicketId: DST })).status).toBe(404);
    getScopedTicketOr404Mock.mockImplementation(async (_a: unknown, id: string) => (id === SRC ? null : row(id)));
    expect((await post({ intoTicketId: DST })).status).toBe(404);
    expect(mergeTicketsMock).not.toHaveBeenCalled();
  });

  it('400 on a bad body', async () => {
    expect((await post({ intoTicketId: 'not-a-uuid' })).status).toBe(400);
  });

  it('passes notifyRequester through (undefined when omitted — the service defaults it to requestersDiffer, D6)', async () => {
    mergeTicketsMock.mockResolvedValue({ survivorId: DST, counts: { ticket_comments: 2 }, droppedLinks: [], retainedExternalRefIds: [], notifyRequester: true });
    const res = await post({ intoTicketId: DST });
    expect(res.status).toBe(200);
    expect(mergeTicketsMock).toHaveBeenCalledWith(
      { sourceTicketId: SRC, intoTicketId: DST, notifyRequester: undefined },
      expect.objectContaining({ kind: 'user', userId: 'u-1' }),
      expect.objectContaining({ canAccessTicket: expect.any(Function) }),
    );
    expect(await res.json()).toEqual({ data: { survivorId: DST, counts: { ticket_comments: 2 }, droppedLinks: [] } });
    await post({ intoTicketId: DST, notifyRequester: false });
    expect(mergeTicketsMock.mock.calls[1]![0]).toMatchObject({ notifyRequester: false });
  });

  it.each([
    'MERGE_SAME_TICKET', 'MERGE_CROSS_ORG', 'MERGE_SOURCE_INELIGIBLE', 'MERGE_SURVIVOR_INELIGIBLE', 'MERGE_DELIVERABLE_PINNED',
    'MERGE_IMPORT_WINDOW', 'MERGE_APPROVAL_STATE', 'MERGE_WORK_KIND_MISMATCH', 'MERGE_PENDING_INTENTS', 'ORG_MERGING', 'MERGE_SCOPE_DENIED',
  ] as const)('409 { error, code: %s, details } for a refusal', async (code) => {
    mergeTicketsMock.mockRejectedValue(new MergeRefusedError(code, 'survivor', 'nope'));
    const res = await post({ intoTicketId: DST });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nope', code, details: { side: 'survivor' } });
  });

  it('409 TICKET_MERGED with the survivor id when the source is already a tombstone', async () => {
    const { TicketMergedError } = await import('../../services/ticketMerge/errors');
    mergeTicketsMock.mockRejectedValue(new TicketMergedError(SRC, 'other'));
    const res = await post({ intoTicketId: DST });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TICKET_MERGED', details: { mergedIntoTicketId: 'other' } });
  });

  it('the scope callback applies the caller\'s site axis to device-bound tickets', async () => {
    mergeTicketsMock.mockResolvedValue({ survivorId: DST, counts: {}, droppedLinks: [], retainedExternalRefIds: [], notifyRequester: false });
    await post({ intoTicketId: DST });
    const ctx = mergeTicketsMock.mock.calls[0]![2] as { canAccessTicket: (t: unknown) => Promise<boolean> };
    deviceInSiteScopeMock.mockResolvedValueOnce(false);
    expect(await ctx.canAccessTicket(row(SRC, { deviceId: 'dev-1' }))).toBe(false);
    expect(deviceInSiteScopeMock).toHaveBeenCalledWith(expect.anything(), 'dev-1');
    expect(await ctx.canAccessTicket(row(SRC))).toBe(true);
  });
});

describe('GET /tickets/:id/merge-preview (#8972 W1)', () => {
  const PREVIEW = {
    eligible: true, refusals: [], counts: {}, droppedLinks: [], retainedExternalRefs: [],
    deviceDifference: { source: null, survivor: null, result: null }, requestersDiffer: false,
    sourceRequesterGainsAccess: false, suggestedSurvivorId: DST,
  };

  it('returns the preview and makes no writes (the db handle is only passed through)', async () => {
    previewMergeMock.mockResolvedValue(PREVIEW);
    const res = await preview();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: PREVIEW });
    expect(dbWrites).not.toHaveBeenCalled();
    expect(mergeTicketsMock).not.toHaveBeenCalled();
    expect(previewMergeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: SRC }), expect.objectContaining({ id: DST }), expect.anything());
  });

  it('403 without tickets:write; 404 out of scope; 400 without ?into', async () => {
    permsRef.current = new Set();
    expect((await preview()).status).toBe(403);
    permsRef.current = new Set(['tickets:write']);
    getScopedTicketOr404Mock.mockResolvedValueOnce(row(SRC)).mockResolvedValueOnce(null);
    expect((await preview()).status).toBe(404);
    expect((await app().request(`/tickets/${SRC}/merge-preview`)).status).toBe(400);
  });

  it('does not require MFA (read-only)', async () => {
    mfaRef.current = false;
    previewMergeMock.mockResolvedValue(PREVIEW);
    expect((await preview()).status).toBe(200);
  });
});
