/**
 * Wisp W07 Task 12 — `bulk_ticket_reply` executor (w00 A30).
 *
 * Drizzle is mocked: each `select().from(<table>)` chain resolves to the rows
 * queued for that table name (the mock does NOT evaluate SQL) and records the
 * DB context it ran in. ticketService and auditService are mocked and every
 * call lands in one ordered `h.calls` log, so the tests can pin order (hold
 * before reply), stop-on-first-failure and "no ticket call at all".
 * `grantAuthority` is the real module (assertWithinCeiling is the gate under
 * test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: {} as Record<string, unknown[]>,
  /** ticketId → error thrown by the PUBLIC reply for that ticket. */
  replyFailures: new Map<string, Error>(),
  ctxDepth: 0,
  auditFailures: new Map<string, Error>(),
  selectCtx: [] as Array<{ table: string; inActorCtx: boolean }>,
}));

vi.mock('../../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = vi.fn(() => {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof getTableName>[0]) => {
      table = getTableName(t);
      h.calls.push(`select:${table}`);
      h.selectCtx.push({ table, inActorCtx: h.ctxDepth > 0 });
      return chain;
    };
    for (const m of ['leftJoin', 'innerJoin', 'orderBy', 'limit', 'where']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve([...(h.rows[table] ?? [])]).then(res, rej);
    return chain;
  });
  return {
    db: { select },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../../../middleware/auth', () => ({
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    h.ctxDepth += 1;
    try { return await fn(); } finally { h.ctxDepth -= 1; }
  }),
}));

vi.mock('../../../routes/tickets/siteScope', () => ({
  ticketCounterpartScopeCondition: vi.fn(() => undefined),
}));

vi.mock('../../ticketService', () => ({
  changeTicketStatus: vi.fn(async (ticketId: string, target: { status?: string }) => {
    h.calls.push(`status:${ticketId}:${target.status}`);
    return { id: ticketId };
  }),
  addTicketComment: vi.fn(async (ticketId: string, input: { content: string; isPublic: boolean }) => {
    h.calls.push(`${input.isPublic ? 'reply' : 'note'}:${ticketId}`);
    const failure = input.isPublic ? h.replyFailures.get(ticketId) : undefined;
    if (failure) throw failure;
    return { comment: { id: `c-${ticketId}` } };
  }),
}));

vi.mock('../../auditService', () => ({
  createAuditLog: vi.fn(async (p: { action: string; resourceId?: string }) => {
    h.calls.push(`audit:${p.action}:${p.resourceId}`);
    const failure = h.auditFailures.get(`${p.action}:${p.resourceId}`);
    if (failure) throw failure;
  }),
  createAuditLogAsync: vi.fn(async () => {}),
}));

import type { AuthContext } from '../../../middleware/auth';
import type { GrantCeiling } from '../grantAuthority';
import { addTicketComment, changeTicketStatus } from '../../ticketService';
import { createAuditLog } from '../../auditService';
import { withAuthDbAccessContext } from '../../../middleware/auth';
import { bulkReplyDigest, executeBulkTicketReply } from './bulkTicketReply';

const P1 = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const HUMAN = '33333333-3333-4333-8333-333333333333';
const O1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const O2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const G1 = '99999999-9999-4999-8999-999999999999';
const R1 = '88888888-8888-4888-8888-888888888888';
const CONCERN = '77777777-7777-4777-8777-777777777777';
const EXEC = '66666666-6666-4666-8666-666666666666';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ceiling = (over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: G1, revisionId: R1, partnerId: P1, grantorUserId: U1, scopeOrgId: null, partnerWide: true,
  orgIds: new Set([O1, O2]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
  deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...over,
});

const actorAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
  principal: { kind: 'user_session' },
  user: { id: HUMAN, email: 'tech@example.test', name: 'Tess Tech', isPlatformAdmin: false },
  token: null,
  partnerId: P1,
  orgId: null,
  scope: 'partner',
  accessibleOrgIds: [O1, O2],
  orgCondition: () => undefined,
  canAccessOrg: (orgId: string) => orgId === O1 || orgId === O2,
  ...over,
} as unknown as AuthContext);

const ticketRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, orgId: O1, status: 'open', mergedIntoTicketId: null, deviceSiteId: null, ...over,
});

const MESSAGE = 'We are aware of the outage and are working on it.';

function params(ticketIds: string[], over: Record<string, unknown> = {}) {
  return { concernId: CONCERN, ticketIds, message: MESSAGE, ...over };
}

function run(ticketIds: string[], over: {
  params?: Record<string, unknown>;
  ceiling?: GrantCeiling;
  actorAuth?: AuthContext;
  pinnedDigest?: string;
  candidates?: readonly string[];
} = {}) {
  const p = params(ticketIds, over.params);
  return executeBulkTicketReply({
    executionId: EXEC,
    ceiling: over.ceiling ?? ceiling(),
    actorAuth: over.actorAuth ?? actorAuth(),
    params: p,
    pinnedDigest: over.pinnedDigest ?? bulkReplyDigest({ ticketIds, message: MESSAGE }),
    ...(over.candidates ? { ticketIds: over.candidates } : {}),
  });
}

const ticketCalls = () => h.calls.filter((c) => /^(status|note|reply):/.test(c));

beforeEach(() => {
  h.calls.length = 0;
  h.selectCtx.length = 0;
  h.rows = {};
  h.replyFailures.clear();
  h.auditFailures.clear();
  h.ctxDepth = 0;
  vi.clearAllMocks();
});

describe('bulkReplyDigest', () => {
  it('is sha256 of the sorted ids joined by "," + newline + message', () => {
    const ids = [uid(2), uid(1)];
    const expected = createHash('sha256').update(`${uid(1)},${uid(2)}\n${MESSAGE}`).digest('hex');
    expect(bulkReplyDigest({ ticketIds: ids, message: MESSAGE })).toBe(expected);
  });

  it('is independent of ticketIds order and does not mutate the input', () => {
    const ids = [uid(3), uid(1), uid(2)];
    const a = bulkReplyDigest({ ticketIds: ids, message: MESSAGE });
    const b = bulkReplyDigest({ ticketIds: [uid(1), uid(2), uid(3)], message: MESSAGE });
    expect(a).toBe(b);
    expect(ids).toEqual([uid(3), uid(1), uid(2)]);
  });

  it('is sensitive to the message and to the set', () => {
    const base = bulkReplyDigest({ ticketIds: [uid(1)], message: MESSAGE });
    expect(bulkReplyDigest({ ticketIds: [uid(1)], message: `${MESSAGE}!` })).not.toBe(base);
    expect(bulkReplyDigest({ ticketIds: [uid(1), uid(2)], message: MESSAGE })).not.toBe(base);
  });
});

describe('executeBulkTicketReply — refusals before any read or write', () => {
  it('invalid params → refused invalid_params, nothing touched', async () => {
    const r = await executeBulkTicketReply({
      executionId: EXEC, ceiling: ceiling(), actorAuth: actorAuth(),
      params: { concernId: CONCERN, ticketIds: [], message: MESSAGE },
      pinnedDigest: 'x',
    });
    expect(r).toMatchObject({ ok: false, refused: 'invalid_params' });
    expect(h.calls).toEqual([]);
  });

  it('tampered params (digest mismatch) → refused digest_mismatch, zero reads and zero ticket calls', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    const r = await executeBulkTicketReply({
      executionId: EXEC, ceiling: ceiling(), actorAuth: actorAuth(),
      // a third ticket was slipped into the stored params after approval
      params: params([...ids, uid(3)]),
      pinnedDigest: bulkReplyDigest({ ticketIds: ids, message: MESSAGE }),
    });
    expect(r).toMatchObject({ ok: false, refused: 'digest_mismatch' });
    expect(h.calls).toEqual([]);
    expect(addTicketComment).not.toHaveBeenCalled();
    expect(changeTicketStatus).not.toHaveBeenCalled();
  });

  it('a tampered message is a digest mismatch too', async () => {
    const r = await run([uid(1)], { params: { message: 'Click here to reset your password' } });
    expect(r).toMatchObject({ ok: false, refused: 'digest_mismatch' });
    expect(h.calls).toEqual([]);
  });

  it('an AI-agent actor is refused: the reply author must be the acting human', async () => {
    const r = await run([uid(1)], {
      actorAuth: actorAuth({ principal: { kind: 'ai_agent', agentId: uid(50), runId: uid(51) } } as Partial<AuthContext>),
    });
    expect(r).toMatchObject({ ok: false, refused: 'actor_not_human' });
    expect(h.calls).toEqual([]);
  });
});

describe('executeBulkTicketReply — the pinned set', () => {
  it('sends to every sendable ticket, public reply authored by the human, one audit row each', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    const r = await run(ids);
    expect(r).toEqual({
      ok: true,
      report: { sent: ids, alreadySent: [], skipped: [], stoppedAt: null, state: 'completed' },
    });
    expect(addTicketComment).toHaveBeenCalledWith(uid(1), { content: MESSAGE, isPublic: true }, { kind: 'user', userId: HUMAN, name: 'Tess Tech', email: 'tech@example.test' });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      orgId: O1, actorId: HUMAN, action: 'ticket.reply.sent', resourceType: 'ticket', resourceId: uid(1), result: 'success',
      details: { executionId: EXEC, grantId: G1, concernId: CONCERN },
    }));
    expect(ticketCalls()).toEqual([`reply:${uid(1)}`, `reply:${uid(2)}`]);
  });

  it('every read runs in the acting human\'s DB context', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    await run([uid(1)]);
    expect(h.selectCtx.length).toBeGreaterThan(0);
    expect(h.selectCtx.every((s) => s.inActorCtx)).toBe(true);
    expect(vi.mocked(withAuthDbAccessContext).mock.calls.every(([a]) => (a as AuthContext).user.id === HUMAN)).toBe(true);
  });

  it('a candidate outside the pinned set is skipped not_in_set and never sent', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = [ticketRow(uid(1)), ticketRow(uid(2)), ticketRow(uid(9))];
    const r = await run(ids, { candidates: [uid(1), uid(9)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.sent).toEqual([uid(1)]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(9), reason: 'not_in_set' }]);
    expect(ticketCalls()).toEqual([`reply:${uid(1)}`]);
  });

  it('a ticket not visible to the actor (or gone) is skipped not_in_org', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    const r = await run([uid(1), uid(2)]);
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([uid(1)]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(2), reason: 'not_in_org' }]);
  });

  it('closed, resolved and merged tickets are skipped closed', async () => {
    const ids = [uid(1), uid(2), uid(3), uid(4)];
    h.rows.tickets = [
      ticketRow(uid(1), { status: 'closed' }),
      ticketRow(uid(2), { status: 'resolved' }),
      ticketRow(uid(3), { mergedIntoTicketId: uid(40) }),
      ticketRow(uid(4)),
    ];
    const r = await run(ids);
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([uid(4)]);
    expect(r.report.skipped).toEqual([
      { ticketId: uid(1), reason: 'closed' },
      { ticketId: uid(2), reason: 'closed' },
      { ticketId: uid(3), reason: 'closed' },
    ]);
    expect(ticketCalls()).toEqual([`reply:${uid(4)}`]);
  });

  it('a ticket in an org outside the ceiling is skipped out_of_ceiling', async () => {
    h.rows.tickets = [ticketRow(uid(1)), ticketRow(uid(2), { orgId: O2 })];
    const r = await run([uid(1), uid(2)], { ceiling: ceiling({ orgIds: new Set([O1]) }) });
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([uid(1)]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(2), reason: 'out_of_ceiling' }]);
  });

  it('a ceiling without tickets:write skips every ticket out_of_ceiling', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    const r = await run([uid(1)], { ceiling: ceiling({ permissionKeys: new Set(['tickets:read']) }) });
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(1), reason: 'out_of_ceiling' }]);
    expect(ticketCalls()).toEqual([]);
  });

  it('a ticket in an org the actor cannot access is skipped out_of_ceiling', async () => {
    h.rows.tickets = [ticketRow(uid(1)), ticketRow(uid(2), { orgId: O2 })];
    const r = await run([uid(1), uid(2)], { actorAuth: actorAuth({ canAccessOrg: (o: string) => o === O1 }) });
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([uid(1)]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(2), reason: 'out_of_ceiling' }]);
  });

  it('a site-restricted ceiling passes a device ticket in an allowed site and skips one outside', async () => {
    const S1 = uid(70);
    h.rows.tickets = [ticketRow(uid(1), { deviceSiteId: S1 }), ticketRow(uid(2), { deviceSiteId: uid(71) })];
    const r = await run([uid(1), uid(2)], { ceiling: ceiling({ siteIds: new Set([S1]) }) });
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([uid(1)]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(2), reason: 'out_of_ceiling' }]);
  });

  it('an inactive ceiling sends nothing', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    const r = await run([uid(1)], { ceiling: ceiling({ status: 'paused' }) });
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([]);
    expect(r.report.skipped).toEqual([{ ticketId: uid(1), reason: 'out_of_ceiling' }]);
  });
});

describe('executeBulkTicketReply — hold, failure, idempotency, batching', () => {
  it('holdTickets: status pending + internal note happen BEFORE the public reply, per ticket', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    const r = await run(ids, { params: { holdTickets: true } });
    expect(r.ok).toBe(true);
    expect(ticketCalls()).toEqual([
      `status:${uid(1)}:pending`, `note:${uid(1)}`, `reply:${uid(1)}`,
      `status:${uid(2)}:pending`, `note:${uid(2)}`, `reply:${uid(2)}`,
    ]);
    // default note names the concern
    const note = vi.mocked(addTicketComment).mock.calls.find(([, input]) => !input.isPublic);
    expect(note?.[1].content).toContain(CONCERN);
  });

  it('holdTickets uses the supplied internal note verbatim', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    await run([uid(1)], { params: { holdTickets: true, internalNote: 'Held: ISP outage' } });
    expect(addTicketComment).toHaveBeenCalledWith(uid(1), { content: 'Held: ISP outage', isPublic: false }, expect.objectContaining({ kind: 'user', userId: HUMAN }));
  });

  it('without holdTickets there is no status change and no internal note', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    await run([uid(1)]);
    expect(changeTicketStatus).not.toHaveBeenCalled();
    expect(vi.mocked(addTicketComment).mock.calls.every(([, input]) => input.isPublic)).toBe(true);
  });

  it('the third send failing stops the batch: two sent, partial, the fourth never attempted', async () => {
    const ids = [uid(1), uid(2), uid(3), uid(4)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    h.replyFailures.set(uid(3), new Error('smtp relay refused'));
    const r = await run(ids);
    expect(r).toEqual({
      ok: true,
      report: {
        sent: [uid(1), uid(2)],
        alreadySent: [],
        skipped: [],
        stoppedAt: { ticketId: uid(3), error: 'smtp relay refused' },
        state: 'partial',
      },
    });
    expect(ticketCalls()).toEqual([`reply:${uid(1)}`, `reply:${uid(2)}`, `reply:${uid(3)}`]);
    expect(h.calls).not.toContain(`audit:ticket.reply.sent:${uid(3)}`);
    expect(h.calls.some((c) => c.includes(uid(4)))).toBe(false);
  });

  it('re-execution with existing audit rows → alreadySent, no second send', async () => {
    const ids = [uid(1), uid(2), uid(3)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    h.rows.audit_logs = [
      { resourceId: uid(1), action: 'ticket.reply.sending' }, { resourceId: uid(1), action: 'ticket.reply.sent' },
      { resourceId: uid(2), action: 'ticket.reply.sending' }, { resourceId: uid(2), action: 'ticket.reply.sent' },
    ];
    const r = await run(ids);
    if (!r.ok) throw new Error('refused');
    expect(r.report).toEqual({ sent: [uid(3)], alreadySent: [uid(1), uid(2)], skipped: [], stoppedAt: null, state: 'completed' });
    expect(ticketCalls()).toEqual([`reply:${uid(3)}`]);
    // one lookup for the whole set, not per ticket
    expect(h.calls.filter((c) => c === 'select:audit_logs')).toHaveLength(1);
    expect(h.calls.filter((c) => c === 'select:tickets')).toHaveLength(1);
  });

  it('a fully re-delivered execution sends nothing', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    h.rows.audit_logs = ids.map((resourceId) => ({ resourceId, action: 'ticket.reply.sent' }));
    const r = await run(ids, { params: { holdTickets: true } });
    if (!r.ok) throw new Error('refused');
    expect(r.report).toMatchObject({ sent: [], alreadySent: ids, state: 'completed' });
    expect(ticketCalls()).toEqual([]);
  });

  it('25 tickets in batches of 10: all 25 sent in the pinned order', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => uid(i + 1));
    h.rows.tickets = [...ids].reverse().map((id) => ticketRow(id));
    const r = await run(ids);
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual(ids);
    expect(r.report.state).toBe('completed');
    expect(ticketCalls()).toEqual(ids.map((id) => `reply:${id}`));
    // Two markers per ticket: `sending` before the reply, `sent` after it.
    expect(createAuditLog).toHaveBeenCalledTimes(50);
  });
});

describe('executeBulkTicketReply — two-phase idempotency marker (no double send to a customer)', () => {
  it('writes `sending` before the reply and `sent` after it, per ticket', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    await run([uid(1)]);
    const seq = h.calls.filter((c) => c.startsWith('audit:') || c.startsWith('reply:'));
    expect(seq).toEqual([`audit:ticket.reply.sending:${uid(1)}`, `reply:${uid(1)}`, `audit:ticket.reply.sent:${uid(1)}`]);
  });

  it('a `sending` marker with no `sent` (crash between reply and marker) is skipped uncertain, never re-sent', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    h.rows.audit_logs = [{ resourceId: uid(1), action: 'ticket.reply.sending' }];
    const r = await run(ids);
    if (!r.ok) throw new Error('refused');
    expect(r.report.skipped).toEqual([{ ticketId: uid(1), reason: 'uncertain' }]);
    expect(r.report.sent).toEqual([uid(2)]);
    expect(ticketCalls()).toEqual([`reply:${uid(2)}`]);
  });

  it('a `sending` marker followed by `failed` (the reply rolled back) is sent again', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    h.rows.audit_logs = [
      { resourceId: uid(1), action: 'ticket.reply.sending' }, { resourceId: uid(1), action: 'ticket.reply.failed' },
    ];
    const r = await run([uid(1)]);
    if (!r.ok) throw new Error('refused');
    expect(r.report.sent).toEqual([uid(1)]);
  });

  it('a reply that throws records `failed` so a redelivery may retry it', async () => {
    h.rows.tickets = [ticketRow(uid(1))];
    h.replyFailures.set(uid(1), new Error('db down'));
    await run([uid(1)]);
    expect(h.calls).toContain(`audit:ticket.reply.failed:${uid(1)}`);
    expect(h.calls).not.toContain(`audit:ticket.reply.sent:${uid(1)}`);
  });

  it('when the `sending` marker cannot be written nothing is sent and the batch stops', async () => {
    const ids = [uid(1), uid(2)];
    h.rows.tickets = ids.map((id) => ticketRow(id));
    h.auditFailures.set(`ticket.reply.sending:${uid(1)}`, new Error('audit down'));
    const r = await run(ids);
    if (!r.ok) throw new Error('refused');
    expect(ticketCalls()).toEqual([]);
    expect(r.report).toMatchObject({ sent: [], state: 'partial', stoppedAt: { ticketId: uid(1) } });
  });
});
