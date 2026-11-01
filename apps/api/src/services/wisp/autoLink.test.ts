import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '../streamingSessionManager';
import type { AuthContext } from '../../middleware/auth';
import type { GrantCeiling } from './grantAuthority';
import type { EntityResolveContext } from './entityRefs';
import type { WispEntityKind } from '@breeze/shared';

const h = vi.hoisted(() => ({ add: vi.fn(), touch: vi.fn(), resolve: vi.fn(), relations: vi.fn(), audit: vi.fn(), request: vi.fn() }));
vi.mock('./threadLinks', async (original) => ({ ...(await original<typeof import('./threadLinks')>()), addLink: h.add, touchLinks: h.touch }));
vi.mock('./entityRefs', () => ({
  createEntityResolver: (ctx: EntityResolveContext) => (ref: unknown) => h.resolve(ctx, ref),
  isResolveFailure: (r: object) => 'reason' in r,
}));
vi.mock('./entityRelations', () => ({ relatedRefs: h.relations }));
vi.mock('../auditEvents', () => ({ writeAuditEvent: h.audit, requestLikeFromSnapshot: h.request }));
import { autoLinkFocalAct } from './autoLink';
import { ThreadLinkError } from './threadLinks';
import * as toolSubjects from './toolSubjects';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PARTNER = uuid(1), GRANT = uuid(2), THREAD = uuid(3), ORG = uuid(4), USER = uuid(5);
const ceiling = { partnerId: PARTNER, grantId: GRANT, revisionId: uuid(6) } as GrantCeiling;
const auth = { user: { id: USER, email: 'operator@example.test' }, partnerId: PARTNER } as AuthContext;
const resolved = (ref: { kind: WispEntityKind; id: string }) => ({
  ref: { ...ref, orgId: ORG }, orgId: ORG, label: 'Server label', status: 'open', href: '/',
});
let session: ActiveSession;
const invoke = (id = uuid(10), toolName = 'manage_tickets', action = 'get') => autoLinkFocalAct({
  session, toolName, input: { ticketId: id, action }, auth, ceiling,
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  session = { wispGrant: { grantId: GRANT, revisionId: ceiling.revisionId, threadId: THREAD },
    auth, pendingTurnAutoLinkCount: 0, auditSnapshot: { userAgent: 'vitest' } } as ActiveSession;
  h.resolve.mockImplementation(async (_ctx: unknown, ref: { kind: WispEntityKind; id: string }) => resolved(ref));
  h.add.mockImplementation(async (_ctx: unknown, _thread: unknown, ref: { kind: WispEntityKind; id: string }) => ({ link: { ...resolved(ref), source: 'auto', id: uuid(11) }, inserted: true }));
  h.touch.mockResolvedValue(0); h.relations.mockResolvedValue([]); h.request.mockReturnValue({ req: {} });
});

describe('autoLinkFocalAct', () => {
  it.each(['user_pin', 'wisp_pin'] as const)('get, comment and update_status only touch a linked %s ticket', async (source) => {
    h.add.mockImplementation(async (_ctx: unknown, _thread: unknown, ref: { kind: WispEntityKind; id: string }) => ({
      link: { ...resolved(ref), source, id: uuid(11) }, inserted: false,
    }));
    session.pendingTurnAutoLinkCount = 2;
    const results = [];
    for (const action of ['get', 'comment', 'update_status']) {
      results.push(await invoke(uuid(10), 'manage_tickets', action));
      expect(session.pendingTurnAutoLinkCount).toBe(2);
    }
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ added: 0, touched: 1 })));
    expect(h.add).toHaveBeenCalledTimes(3);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.touch.mock.calls.every((call) => call[2].length === 0)).toBe(true);
  });
  it('eight concurrent calls with three existing subjects insert all five new subjects', async () => {
    h.add.mockImplementation(async (_ctx: unknown, _thread: unknown, ref: { kind: WispEntityKind; id: string }) => ({
      link: { ...resolved(ref), source: ref.id < uuid(23) ? 'user_pin' : 'auto', id: uuid(11) },
      inserted: ref.id >= uuid(23),
    }));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => invoke(uuid(i + 20))));
    expect(results.reduce((sum, r) => sum + r.added, 0)).toBe(5);
    expect(results.reduce((sum, r) => sum + r.touched, 0)).toBe(3);
    expect(session.pendingTurnAutoLinkCount).toBe(5);
    expect(h.add).toHaveBeenCalledTimes(8);
    expect(h.audit).toHaveBeenCalledTimes(5);
    expect(h.audit.mock.calls.every((call) => call[1].details.source === 'auto')).toBe(true);
  });
  it('does not release a detached prior-turn touch into the next turn budget', async () => {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    h.add.mockImplementationOnce(async () => {
      await barrier;
      return { link: { ...resolved({ kind: 'ticket', id: uuid(10) }), source: 'user_pin' }, inserted: false };
    });
    const priorTurn = invoke();
    await vi.waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    session.pendingTurnUsage = {} as ActiveSession['pendingTurnUsage'];
    session.pendingTurnAutoLinkCount = 2;
    finish();
    expect(await priorTurn).toEqual({ added: 0, touched: 1 });
    expect(session.pendingTurnAutoLinkCount).toBe(2);
  });
  it('audits the inserted row source and skips audit when the snapshot is null', async () => {
    h.add.mockResolvedValue({ link: { ...resolved({ kind: 'ticket', id: uuid(10) }), source: 'wisp_pin' }, inserted: true });
    await invoke();
    expect(h.audit.mock.calls[0]?.[1].details.source).toBe('wisp_pin');
    h.audit.mockClear();
    // Exercise the defensive runtime guard for callers without a snapshot.
    session = { ...session, auditSnapshot: null } as unknown as ActiveSession;
    expect(await invoke(uuid(12))).toEqual({ added: 1, touched: 0 });
    expect(h.audit).not.toHaveBeenCalled();
  });
  it('releases current and later unattempted reservations on a resolver throw and annotates the failure', async () => {
    vi.spyOn(toolSubjects, 'subjectRefsOf').mockReturnValueOnce([20, 21, 22].map((n) => ({ kind: 'ticket', id: uuid(n) })));
    const cause = new Error('resolver unavailable');
    h.resolve.mockImplementation(async (_ctx: unknown, ref: { kind: WispEntityKind; id: string }) => {
      if (ref.id === uuid(21)) throw cause;
      return resolved(ref);
    });
    let error: unknown;
    try { await invoke(); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`ticket:${uuid(21)}`);
    expect((error as Error).message).toContain(THREAD);
    expect((error as Error).message).toContain('released=2');
    expect((error as Error).message).toContain('abandoned=2');
    expect((error as Error).cause).toBe(cause);
    expect(session.pendingTurnAutoLinkCount).toBe(1);
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });
  it('retains a slot once addLink was entered but releases later reservations on an unexpected throw', async () => {
    vi.spyOn(toolSubjects, 'subjectRefsOf').mockReturnValueOnce([20, 21].map((n) => ({ kind: 'ticket', id: uuid(n) })));
    const cause = new Error('insert outcome unknown');
    h.add.mockRejectedValueOnce(cause);
    await expect(invoke()).rejects.toMatchObject({ cause, message: expect.stringContaining('released=1') });
    expect(session.pendingTurnAutoLinkCount).toBe(1);
    expect(h.add).toHaveBeenCalledTimes(1);
  });
  it('logs a mismatched grant without resolving a subject', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    session = { ...session, wispGrant: { grantId: uuid(99), revisionId: ceiling.revisionId, threadId: THREAD } };
    await invoke();
    expect(debug).toHaveBeenCalledExactlyOnceWith('[Wisp] Auto-link grant mismatch', {
      grantId: ceiling.grantId, threadId: THREAD, toolName: 'manage_tickets', reason: 'grant_mismatch',
    });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('links manage_tickets get with the call auth and ceiling, never a client label', async () => {
    expect(await invoke()).toEqual({ added: 1, touched: 0 });
    expect(h.add).toHaveBeenCalledExactlyOnceWith({ auth, ceiling }, THREAD, { kind: 'ticket', id: uuid(10) }, { source: 'auto', addedByGrantId: GRANT, reportInsertion: true });
    expect(session.pendingTurnAutoLinkCount).toBe(1);
    expect(h.resolve).toHaveBeenCalledWith({ auth, ceiling }, { kind: 'ticket', id: uuid(10) });
  });
  it.each(['list', 'search'])('does not link from a %s action', async (action) => {
    expect(await invoke(uuid(10), 'manage_tickets', action)).toEqual({ added: 0, touched: 0 });
    expect(h.resolve).not.toHaveBeenCalled(); expect(h.add).not.toHaveBeenCalled();
    expect(session.pendingTurnAutoLinkCount).toBe(0);
  });
  it('a fleet/list tool with hundreds of input ids adds nothing', async () => {
    expect(await autoLinkFocalAct({ session, toolName: 'query_devices', input: { deviceIds: Array.from({ length: 300 }, (_, i) => uuid(i + 20)) }, auth, ceiling })).toEqual({ added: 0, touched: 0 });
    expect(h.resolve).not.toHaveBeenCalled();
  });
  it('does nothing outside a Wisp session or for a mismatched grant', async () => {
    session = { ...session, wispGrant: null };
    expect(await invoke()).toEqual({ added: 0, touched: 0 });
    session = { ...session, wispGrant: { grantId: uuid(99), revisionId: ceiling.revisionId, threadId: THREAD } };
    expect(await invoke()).toEqual({ added: 0, touched: 0 });
    expect(h.add).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled();
  });
  it('reserves five slots synchronously under eight concurrent calls; the rest touch only', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    h.resolve.mockImplementation(async (_ctx: unknown, ref: { kind: WispEntityKind; id: string }) => { await barrier; return resolved(ref); });
    h.touch.mockResolvedValue(1);
    const calls = Array.from({ length: 8 }, (_, i) => invoke(uuid(i + 20)));
    expect(session.pendingTurnAutoLinkCount).toBe(5);
    release();
    const results = await Promise.all(calls);
    expect(h.add).toHaveBeenCalledTimes(5);
    expect(results.reduce((sum, r) => sum + r.added, 0)).toBe(5);
    const subjects = h.touch.mock.calls.flatMap((call) => call[2]);
    expect(subjects).toEqual([20, 21, 22].map((n) => resolved({ kind: 'ticket', id: uuid(n + 5) }).ref));
    for (const call of h.touch.mock.calls) expect(call.slice(0, 2)).toEqual([PARTNER, THREAD]);
  });
  it.each(['not_found', 'forbidden', 'outside_ceiling', 'outside_token_scope'])('a refused resolve (%s) adds and touches nothing, without throwing', async (reason) => {
    h.resolve.mockResolvedValue({ reason });
    expect(await invoke()).toEqual({ added: 0, touched: 0 });
    expect(h.add).not.toHaveBeenCalled(); expect(h.relations).not.toHaveBeenCalled();
    expect(h.touch).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
    expect(session.pendingTurnAutoLinkCount).toBe(1);
  });
  it('a refusal during addLink re-resolution adds nothing and throws nothing', async () => {
    h.add.mockRejectedValue(new ThreadLinkError('outside_ceiling'));
    expect(await invoke()).toEqual({ added: 0, touched: 0 });
    expect(h.touch).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it('unexpected resolver failures propagate to the detached success hook capture', async () => {
    h.resolve.mockRejectedValue(new Error('resolver unavailable'));
    await expect(invoke()).rejects.toThrow('resolver unavailable');
    expect(h.add).not.toHaveBeenCalled();
  });
  it('writes wisp.thread.link_added with source auto, grant and AI attribution', async () => {
    await invoke();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(session.auditSnapshot);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({ req: {} }, expect.objectContaining({
      action: 'wisp.thread.link_added', orgId: ORG, partnerId: PARTNER,
      resourceType: 'wisp_thread', resourceId: THREAD, actorId: USER, initiatedBy: 'ai', result: 'success',
      details: expect.objectContaining({ source: 'auto', threadId: THREAD, grantId: GRANT, kind: 'ticket', entityId: uuid(10) }),
    }));
  });
  it('resolves and touches only authorized existing relations, never inserts neighbours', async () => {
    h.relations.mockResolvedValue([{ kind: 'device', id: uuid(30) }, { kind: 'organization', id: uuid(31) }]);
    h.resolve.mockImplementation(async (_ctx: unknown, ref: { kind: WispEntityKind; id: string }) => ref.id === uuid(31) ? { reason: 'forbidden' } : resolved(ref));
    h.touch.mockResolvedValue(1);
    expect(await invoke()).toEqual({ added: 1, touched: 1 });
    expect(h.relations).toHaveBeenCalledExactlyOnceWith(PARTNER, { kind: 'ticket', id: uuid(10) });
    expect(h.touch).toHaveBeenCalledExactlyOnceWith(PARTNER, THREAD, [resolved({ kind: 'device', id: uuid(30) }).ref]);
    expect(h.add).toHaveBeenCalledTimes(1);
  });
  it('at the turn cap resolves and touches the subject and relations without audit or insertion', async () => {
    session.pendingTurnAutoLinkCount = 5;
    h.relations.mockResolvedValue([{ kind: 'organization', id: ORG }]);
    h.touch.mockResolvedValue(2);
    expect(await invoke()).toEqual({ added: 0, touched: 2 });
    expect(h.add).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
    expect(h.touch).toHaveBeenCalledExactlyOnceWith(PARTNER, THREAD, [resolved({ kind: 'ticket', id: uuid(10) }).ref, resolved({ kind: 'organization', id: ORG }).ref]);
  });
});
