import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MAILBOX_VERIFICATION_FAILED, MailboxPlatformNotConfiguredError } from '../services/ticketMailbox/mailboxErrors';

// Worker CAS helpers self-wrap so FORCE-RLS writes run under system scope. This is a unit test
// with no database, so make the helpers pass-throughs that just invoke their
// callback — the real context behavior is exercised by the cursor RLS
// integration test (ticketMailboxCursor.rls.integration.test.ts).
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => any) => fn(),
  withSystemDbAccessContext: (fn: () => any) => fn(),
}));

const { workerCloseMock, workerConstructorMock, queueConstructorMock, queueAddMock, queueCloseMock } = vi.hoisted(() => ({
  workerCloseMock: vi.fn(),
  workerConstructorMock: vi.fn(),
  queueConstructorMock: vi.fn(),
  queueAddMock: vi.fn(),
  queueCloseMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }
  },
  Queue: class {
    add = queueAddMock;
    close = queueCloseMock;
    constructor(...args: unknown[]) {
      queueConstructorMock(...args);
    }
  },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

vi.mock('../services/ticketMailbox/connectionService', () => ({
  isConnectedMailboxSnapshotCurrent: vi.fn(async () => true),
  listConnectedMailboxes: vi.fn(),
  // The sweep also enumerates Gmail mailboxes now; this suite covers the M365
  // path, so return none (its own suites cover the Gmail sweep).
  listConnectedGmailMailboxes: vi.fn(async () => []),
  updateDeltaCursor: vi.fn(async () => {}),
  resetDeltaCursor: vi.fn(async () => {}),
  recordTransientPollFailure: vi.fn(async () => 1),
  recordPollAttempt: vi.fn(async () => true),
  releasePollAttempt: vi.fn(async () => true),
  setConnectedMailboxStatus: vi.fn(async () => {}),
  seedDeltaFloor: vi.fn(async () => null),
}));
vi.mock('../services/ticketMailbox/mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
vi.mock('../services/ticketMailbox/graphMailClient', async (importOriginal) => ({
  // The real classifier: these tests assert how the sweep reacts to each failure.
  classifyGraphPollError: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).classifyGraphPollError,
  GraphSweepBudgetError: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).GraphSweepBudgetError,
  GRAPH_POLL_SWEEP_BUDGET_MS: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).GRAPH_POLL_SWEEP_BUDGET_MS,
  isDeltaCursorExpired: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).isDeltaCursorExpired,
  listInboxDelta: vi.fn(),
  markRead: vi.fn(async () => {}),
}));
vi.mock('../services/ticketMailbox/normalizeGraphMessage', () => ({
  normalizeGraphMessage: vi.fn((msg: any, partnerId: string, mailbox: string) => ({
    provider: 'm365', providerMessageId: msg.id, resolvedPartnerId: partnerId, to: mailbox,
    from: 'x@y.com', subject: '', text: '', attachments: [], raw: {},
  })),
}));
vi.mock('../services/ticketMailbox/arcSeal', () => ({
  evaluateTrustedArc: vi.fn(async () => undefined),
}));
vi.mock('../services/inboundEmailQueue', () => ({ enqueueInboundEmail: vi.fn(async () => {}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import {
  isConnectedMailboxSnapshotCurrent,
  listConnectedMailboxes,
  updateDeltaCursor,
  resetDeltaCursor,
  recordTransientPollFailure,
  recordPollAttempt,
  releasePollAttempt,
  setConnectedMailboxStatus,
  seedDeltaFloor,
} from '../services/ticketMailbox/connectionService';
import { getMailboxToken } from '../services/ticketMailbox/mailboxToken';
import { GraphSweepBudgetError, listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';
import { evaluateTrustedArc } from '../services/ticketMailbox/arcSeal';
import { normalizeGraphMessage } from '../services/ticketMailbox/normalizeGraphMessage';
import { captureException } from '../services/sentry';
import {
  GRAPH_POLL_ATTEMPT_CLAIM_MS,
  GRAPH_POLL_FAIR_SHARE_MS,
  GRAPH_POLL_MIN_MAILBOX_START_MS,
  GRAPH_POLL_PASS_BUDGET_MS,
  runMailboxSweep,
  initializeTicketMailboxPollWorker,
  shutdownTicketMailboxPollWorker,
} from './ticketMailboxPollWorker';

// A mailbox that was already polling before connect baselines existed (#10863):
// it has a cursor and no floor. The suite's default, because that behaviour is unchanged.
const STORED_CURSOR = 'https://graph.microsoft.com/delta-stored';

const conn = (over: Partial<any> = {}) => ({
  id: 'c1', partnerId: 'p1', tenantId: '11111111-1111-1111-1111-111111111111',
  consentAttemptId: '22222222-2222-4222-8222-222222222222',
  mailboxAddress: 'support@a.com', status: 'connected', deltaLink: STORED_CURSOR,
  eligibleAfter: null, baselineCompletedAt: null, ...over,
});

describe('runMailboxSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does no token or Graph work when verified active selection is empty', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([]);

    await runMailboxSweep();

    expect(getMailboxToken).not.toHaveBeenCalled();
    expect(listInboxDelta).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('enqueues each new message, marks it read, then persists the new deltaLink', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [{ id: 'm1' }, { id: 'm2' }], deltaLink: 'delta-new' } as any);

    await runMailboxSweep();

    expect(enqueueInboundEmail).toHaveBeenCalledTimes(2);
    expect(enqueueInboundEmail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerMessageId: 'm1' }),
      {
        provider: 'm365',
        connectionId: 'c1',
        partnerId: 'p1',
        tenantId: conn().tenantId,
        consentAttemptId: conn().consentAttemptId,
      },
    );
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(updateDeltaCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', consentAttemptId: conn().consentAttemptId }),
      STORED_CURSOR, 'delta-new', expect.any(Date), expect.anything(),
    );
    const enqueueOrder = vi.mocked(enqueueInboundEmail).mock.invocationCallOrder[0]!;
    const cursorOrder = vi.mocked(updateDeltaCursor).mock.invocationCallOrder[0]!;
    expect(enqueueOrder).toBeLessThan(cursorOrder);
  });

  it("evaluates each message's ARC chain against the connection's sealers and passes the result on (#10862)", async () => {
    const headers = [{ name: 'ARC-Seal', value: 'i=1' }];
    const arc = { status: 'verified', sealer: 'gateway.example', instance: 1, authResults: 'gw; dmarc=pass' } as const;
    vi.mocked(evaluateTrustedArc).mockResolvedValueOnce(arc);
    vi.mocked(listConnectedMailboxes).mockResolvedValue([{ ...conn(), trustedArcSealers: ['gateway.example'] }] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({
      messages: [{ id: 'm1', internetMessageHeaders: headers, receivedDateTime: '2026-11-04T12:00:00Z' }],
      deltaLink: 'delta-new',
    } as any);

    await runMailboxSweep();

    expect(evaluateTrustedArc).toHaveBeenCalledWith(headers, ['gateway.example'], '2026-11-04T12:00:00Z');
    expect(normalizeGraphMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'p1', expect.any(String), { arc });
  });

  it('retries recent mail next sweep, without enqueueing it or moving the cursor, when the sealer key lookup fails (#10862)', async () => {
    vi.mocked(evaluateTrustedArc).mockResolvedValueOnce({ status: 'dns-unavailable', sealer: 'gateway.example', retryable: true });
    vi.mocked(listConnectedMailboxes).mockResolvedValue([{ ...conn(), trustedArcSealers: ['gateway.example'] }] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({
      messages: [{ id: 'm1', receivedDateTime: new Date().toISOString() }],
      deltaLink: 'delta-new',
    } as any);

    await runMailboxSweep();

    expect(enqueueInboundEmail).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
    expect(recordTransientPollFailure).toHaveBeenCalledTimes(1);
  });

  it('lets mail older than the retry window through to quarantine when the sealer key lookup fails', async () => {
    vi.mocked(evaluateTrustedArc).mockResolvedValueOnce({ status: 'dns-unavailable', sealer: 'gateway.example', retryable: true });
    vi.mocked(listConnectedMailboxes).mockResolvedValue([{ ...conn(), trustedArcSealers: ['gateway.example'] }] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({
      messages: [{ id: 'm1', receivedDateTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }],
      deltaLink: 'delta-new',
    } as any);

    await runMailboxSweep();

    expect(enqueueInboundEmail).toHaveBeenCalledTimes(1);
    expect(updateDeltaCursor).toHaveBeenCalledTimes(1);
  });

  it('does not hold mail for a retry when the failing selector was never seen to resolve (sender-chosen)', async () => {
    vi.mocked(evaluateTrustedArc).mockResolvedValueOnce({ status: 'dns-unavailable', sealer: 'gateway.example', retryable: false });
    vi.mocked(listConnectedMailboxes).mockResolvedValue([{ ...conn(), trustedArcSealers: ['gateway.example'] }] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({
      messages: [{ id: 'm1', receivedDateTime: new Date().toISOString() }],
      deltaLink: 'delta-new',
    } as any);

    await runMailboxSweep();

    expect(enqueueInboundEmail).toHaveBeenCalledTimes(1);
    expect(updateDeltaCursor).toHaveBeenCalledTimes(1);
  });

  it('does not persist a cursor if enqueue throws (replay-safe)', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [{ id: 'm1' }], deltaLink: 'delta-new' } as any);
    vi.mocked(enqueueInboundEmail).mockRejectedValueOnce(new Error('redis down'));

    await runMailboxSweep();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
    expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
  });

  it('marks reauth_required on a 401 from Graph and isolates per mailbox', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'bad' }), conn({ id: 'good' })] as any);
    vi.mocked(listInboxDelta)
      .mockImplementationOnce(async () => { const e: any = new Error('401'); e.status = 401; throw e; })
      .mockResolvedValueOnce({ messages: [], deltaLink: 'd' } as any);

    await runMailboxSweep();
    expect(setConnectedMailboxStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bad', consentAttemptId: conn().consentAttemptId }),
      'reauth_required', expect.any(String),
    );
    expect(updateDeltaCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'good', consentAttemptId: conn().consentAttemptId }),
      STORED_CURSOR, 'd', expect.any(Date), expect.anything(),
    );
  });

  it('resets the cursor on a 410 Gone and stays connected', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('410'); e.status = 410; throw e; });

    await runMailboxSweep();
    expect(resetDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({
      id: 'c1', consentAttemptId: conn().consentAttemptId,
    }), STORED_CURSOR);
    expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
  });

  it('requests the stored resume cursor and resets it when Graph answers 410 (#8400)', async () => {
    const stored = 'https://graph.microsoft.com/v1.0/users/x/mailFolders/inbox/messages/delta?$skiptoken=abc';
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ deltaLink: stored })] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('410'); e.status = 410; throw e; });

    await runMailboxSweep();
    expect(vi.mocked(listInboxDelta).mock.calls[0]![2]).toBe(stored);
    expect(resetDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), stored);
    expect(updateDeltaCursor).not.toHaveBeenCalled();
  });

  // #8299: one Graph or token-endpoint hiccup must not stop the mailbox. The
  // sweep only selects 'connected' rows, so 'error' would need a manual reconnect.
  it.each([
    ['Graph 502', () => { const e: any = new Error('Graph delta 502: UnknownError'); e.status = 502; return e; }],
    ['Graph 503', () => { const e: any = new Error('Graph delta 503'); e.status = 503; return e; }],
    ['Graph 429 after the client retry', () => { const e: any = new Error('Graph delta 429'); e.status = 429; return e; }],
    ['Graph 408 request timeout', () => { const e: any = new Error('Graph delta 408'); e.status = 408; return e; }],
    ['a dropped connection', () => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })],
    ['a spent sweep budget (#8308)', () => new GraphSweepBudgetError('Graph sweep budget spent')],
  ])('stays connected and retries next sweep on %s', async (_label, makeErr) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { throw makeErr(); });

    await runMailboxSweep();
    expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
    expect(resetDeltaCursor).not.toHaveBeenCalled();
    // #8308: the failure is counted on the connection instead of only logged.
    expect(recordTransientPollFailure).toHaveBeenCalledTimes(1);
    expect(recordTransientPollFailure).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.any(Date));
  });

  it('keeps the Graph error text out of the stored failure record (#8308)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
      const e: any = new Error('Graph delta 503: {"error":{"message":"upstream detail"}}'); e.status = 503; throw e;
    });

    await runMailboxSweep();
    const args = vi.mocked(recordTransientPollFailure).mock.calls[0]!;
    expect(args).toHaveLength(2);
    expect(JSON.stringify(args)).not.toContain('upstream detail');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('transient'), expect.objectContaining({ consecutiveFailures: 1 }));
  });

  it('gets one token per mailbox and shares one deadline across the delta read and mark-read (#8308)', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [{ id: 'm1' }, { id: 'm2' }], deltaLink: 'delta-new' } as any);

    await runMailboxSweep();
    expect(getMailboxToken).toHaveBeenCalledTimes(1);
    const deadlineAt = (vi.mocked(listInboxDelta).mock.calls[0]![3] as { deadlineAt: number }).deadlineAt;
    expect(typeof deadlineAt).toBe('number');
    expect(vi.mocked(markRead).mock.calls.map((c) => c[3])).toEqual([deadlineAt, deadlineAt]);
  });

  it('a round that did not finish stores its resumeLink as the cursor after enqueueing (#8400)', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValueOnce({
      messages: [{ id: 'm1' }, { id: 'm2' }],
      deltaLink: null,
      resumeLink: 'https://graph.microsoft.com/next-7',
    } as any);

    await runMailboxSweep();
    expect(enqueueInboundEmail).toHaveBeenCalledTimes(2);
    expect(updateDeltaCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }), STORED_CURSOR, 'https://graph.microsoft.com/next-7', expect.any(Date), expect.any(Date),
    );
    expect(recordTransientPollFailure).not.toHaveBeenCalled();
  });

  it('advances the cursor with a compare-and-swap on the cursor the sweep started from', async () => {
    const stored = 'https://graph.microsoft.com/next-7';
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ deltaLink: stored })] as any);
    vi.mocked(listInboxDelta).mockResolvedValueOnce({ messages: [], deltaLink: null, resumeLink: 'https://graph.microsoft.com/next-9' } as any);

    await runMailboxSweep();
    expect(updateDeltaCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }), stored, 'https://graph.microsoft.com/next-9', expect.any(Date), expect.any(Date),
    );
  });

  it('skips mark-read once the sweep budget is spent but still enqueues and advances the cursor (#8308)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async (_t, _m, _d, opts) => {
      // The delta read used up the whole budget.
      vi.setSystemTime((opts as { deadlineAt: number }).deadlineAt + 1);
      return { messages: [{ id: 'm1' }, { id: 'm2' }], deltaLink: 'delta-new' } as any;
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await runMailboxSweep();
    } finally {
      vi.useRealTimers();
    }
    expect(enqueueInboundEmail).toHaveBeenCalledTimes(2);
    expect(markRead).not.toHaveBeenCalled();
    expect(updateDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), STORED_CURSOR, 'delta-new', expect.any(Date), expect.any(Date));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left messages unread'), { id: 'c1', count: 2, limit: 'pass_deadline' });
  });

  // #10863: connecting an existing mailbox must not import its backlog. The floor
  // (eligibleAfter) decides what is new; the baseline columns only count what it
  // left behind, for the card's note.
  describe('connect baseline (#10863)', () => {
    const FLOOR = new Date('2026-11-01T12:00:00.500Z');
    const backlog = (id: string, receivedDateTime = '2026-10-01T09:00:00Z') => ({ id, receivedDateTime });
    const fresh = (id: string, receivedDateTime = '2026-11-01T12:05:00Z') => ({ id, receivedDateTime });
    /** A mailbox just connected: a floor, no cursor, baseline still open. */
    const connecting = (over: Partial<any> = {}) => conn({
      deltaLink: null, eligibleAfter: FLOOR, baselineCompletedAt: null, ...over,
    });
    /** A mailbox whose baseline finished: a floor and a real deltaLink. */
    const baselined = (over: Partial<any> = {}) => conn({
      deltaLink: STORED_CURSOR, eligibleAfter: FLOOR, baselineCompletedAt: new Date('2026-11-01T12:10:00Z'), ...over,
    });
    const enqueuedIds = () => vi.mocked(enqueueInboundEmail).mock.calls.map(([email]) => email.providerMessageId);
    const markedIds = () => vi.mocked(markRead).mock.calls.map((call) => call[2]);

    it('first poll of a backlog enqueues nothing, marks nothing read and stores the deltaLink', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), backlog('old-2'), backlog('old-3')], deltaLink: 'delta-baseline',
      } as any);

      await runMailboxSweep();

      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(markRead).not.toHaveBeenCalled();
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 3, completed: true },
      );
    });

    it('the poll after the baseline enqueues only what is new, including when Graph re-reports touched backlog', async () => {
      // A technician reading or flagging an old message makes delta report it again.
      vi.mocked(listConnectedMailboxes).mockResolvedValue([baselined()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-touched'), fresh('new-1')], deltaLink: 'delta-2',
      } as any);

      await runMailboxSweep();

      expect(vi.mocked(listInboxDelta).mock.calls[0]![2]).toBe(STORED_CURSOR);
      expect(enqueuedIds()).toEqual(['new-1']);
      expect(markedIds()).toEqual(['new-1']);
      // The baseline is closed, so nothing here touches the count on the card.
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), STORED_CURSOR, 'delta-2', expect.any(Date), expect.anything(),
      );
    });

    it('a baseline spanning several sweeps stays a baseline: it resumes, counts each part, and only then closes', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValueOnce([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), backlog('old-2')], deltaLink: null,
        resumeLink: 'https://graph.microsoft.com/next-2', resumeReason: 'page_cap',
      } as any);
      await runMailboxSweep();

      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(updateDeltaCursor).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'https://graph.microsoft.com/next-2', expect.any(Date), expect.anything(),
        { skipped: 2, completed: false },
      );

      // Next sweep reads the stored resumeLink. It is not a finished deltaLink, and
      // the backlog on the remaining pages must still not be imported.
      vi.mocked(listConnectedMailboxes).mockResolvedValueOnce([connecting({ deltaLink: 'https://graph.microsoft.com/next-2' })] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-3')], deltaLink: 'delta-baseline',
      } as any);
      await runMailboxSweep();

      expect(vi.mocked(listInboxDelta).mock.calls[1]![2]).toBe('https://graph.microsoft.com/next-2');
      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(markRead).not.toHaveBeenCalled();
      expect(updateDeltaCursor).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'c1' }), 'https://graph.microsoft.com/next-2', 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 1, completed: true },
      );
    });

    it('mail received while the baseline is being walked is imported, not swallowed by it', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), fresh('during-walk'), backlog('old-2')], deltaLink: 'delta-baseline',
      } as any);

      await runMailboxSweep();

      expect(enqueuedIds()).toEqual(['during-walk']);
      expect(markedIds()).toEqual(['during-walk']);
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 2, completed: true },
      );
    });

    it('compares at whole seconds: Graph drops the milliseconds the floor carries', async () => {
      // Floor is 12:00:00.500. A message that really arrived at 12:00:00.700 is
      // reported as 12:00:00Z and must not read as older than the floor.
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('second-before', '2026-11-01T11:59:59Z'), fresh('floor-second', '2026-11-01T12:00:00Z')],
        deltaLink: 'delta-baseline',
      } as any);

      await runMailboxSweep();

      expect(enqueuedIds()).toEqual(['floor-second']);
    });

    it.each([
      ['a read that fails transiently', 503, 'transient'],
      ['a read cut off by the pass deadline', undefined, 'budget'],
    ])('a baseline that stops on %s imports nothing and writes no cursor; the retry is still floored', async (_label, status, kind) => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
        if (kind === 'budget') throw new GraphSweepBudgetError('spent');
        const e: any = new Error('Graph delta 503'); e.status = status; throw e;
      });

      await runMailboxSweep();

      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(updateDeltaCursor).not.toHaveBeenCalled();
      expect(resetDeltaCursor).not.toHaveBeenCalled();
      expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
      expect(recordTransientPollFailure).toHaveBeenCalledTimes(1);

      // The row is unchanged, so the next sweep is the same floored first poll, not
      // a fallback to a full import.
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), backlog('old-2')], deltaLink: 'delta-baseline',
      } as any);
      await runMailboxSweep();

      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(markRead).not.toHaveBeenCalled();
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 2, completed: true },
      );
    });

    it('a stored resumeLink that then fails midway keeps its place and still imports no backlog', async () => {
      const resume = 'https://graph.microsoft.com/next-5';
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting({ deltaLink: resume })] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('Graph delta 503'); e.status = 503; throw e; });

      await runMailboxSweep();

      expect(updateDeltaCursor).not.toHaveBeenCalled();
      expect(resetDeltaCursor).not.toHaveBeenCalled();

      vi.mocked(listInboxDelta).mockResolvedValueOnce({ messages: [backlog('old-9')], deltaLink: 'delta-baseline' } as any);
      await runMailboxSweep();

      expect(vi.mocked(listInboxDelta).mock.calls[1]![2]).toBe(resume);
      expect(enqueueInboundEmail).not.toHaveBeenCalled();
    });

    it.each([
      ['410 Gone', 410, undefined],
      ['Graph syncStateNotFound on a 400', 400, 'syncStateNotFound'],
    ])('an expired cursor (%s) re-baselines: cleared, then the re-walk imports no backlog', async (_label, status, graphCode) => {
      vi.mocked(listConnectedMailboxes).mockResolvedValueOnce([baselined()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
        const e: any = new Error(`Graph delta ${status}`); e.status = status; e.graphCode = graphCode; throw e;
      });

      await runMailboxSweep();

      expect(resetDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), STORED_CURSOR);
      expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
      expect(enqueueInboundEmail).not.toHaveBeenCalled();

      // The next sweep has no cursor but keeps its floor, so the whole inbox coming
      // back from the fresh delta imports only mail newer than connect.
      vi.mocked(listConnectedMailboxes).mockResolvedValueOnce([baselined({ deltaLink: null })] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), backlog('old-2'), fresh('gap-mail')], deltaLink: 'delta-again',
      } as any);
      await runMailboxSweep();

      expect(vi.mocked(listInboxDelta).mock.calls[1]![2]).toBeNull();
      expect(enqueuedIds()).toEqual(['gap-mail']);
      expect(seedDeltaFloor).not.toHaveBeenCalled();
    });

    it('a 4xx that is not an expired cursor still stops the mailbox', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([baselined()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
        const e: any = new Error('Graph delta 400'); e.status = 400; e.graphCode = 'BadRequest'; throw e;
      });

      await runMailboxSweep();

      expect(resetDeltaCursor).not.toHaveBeenCalled();
      expect(setConnectedMailboxStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'error', expect.any(String));
    });

    it('an existing connection with a deltaLink and no floor is unchanged: old mail still flows', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-looking'), { id: 'no-date' }], deltaLink: 'delta-new',
      } as any);

      await runMailboxSweep();

      expect(seedDeltaFloor).not.toHaveBeenCalled();
      expect(enqueuedIds()).toEqual(['old-looking', 'no-date']);
      expect(markedIds()).toEqual(['old-looking', 'no-date']);
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), STORED_CURSOR, 'delta-new', expect.any(Date), expect.anything(),
      );
    });

    it('a row with neither cursor nor floor gets a floor before Graph is read, then walks under it', async () => {
      const seeded = new Date('2026-11-02T08:00:00Z');
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ deltaLink: null })] as any);
      vi.mocked(seedDeltaFloor).mockResolvedValueOnce({ eligibleAfter: seeded, baselineCompletedAt: null });
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1', '2026-11-02T07:59:00Z'), fresh('new-1', '2026-11-02T08:00:01Z')], deltaLink: 'delta-baseline',
      } as any);

      await runMailboxSweep();

      expect(vi.mocked(seedDeltaFloor).mock.invocationCallOrder[0]!)
        .toBeLessThan(vi.mocked(listInboxDelta).mock.invocationCallOrder[0]!);
      expect(enqueuedIds()).toEqual(['new-1']);
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 1, completed: true },
      );
    });

    it('a row seeded as already baselined walks under its floor but does not count', async () => {
      // A mailbox that polled before this fix and lost its cursor: the note on the
      // card describes a connect, and this is not one.
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ deltaLink: null })] as any);
      vi.mocked(seedDeltaFloor).mockResolvedValueOnce({
        eligibleAfter: new Date('2026-11-02T08:00:00Z'), baselineCompletedAt: new Date('2026-11-02T08:30:00Z'),
      });
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1', '2026-11-02T07:59:00Z')], deltaLink: 'delta-baseline',
      } as any);

      await runMailboxSweep();

      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
      );
    });

    it('never reads Graph with neither cursor nor floor when the floor write lands on no row', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ deltaLink: null })] as any);
      vi.mocked(seedDeltaFloor).mockResolvedValueOnce(null);

      await runMailboxSweep();
      const said = info.mock.calls.find(([line]) => String(line).includes('connect floor not seeded'));
      info.mockRestore();

      expect(said?.[1]).toEqual({ id: 'c1' });

      expect(getMailboxToken).not.toHaveBeenCalled();
      expect(listInboxDelta).not.toHaveBeenCalled();
      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(updateDeltaCursor).not.toHaveBeenCalled();
    });

    it('never reads Graph with neither cursor nor floor when the floor write fails', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ deltaLink: null })] as any);
      vi.mocked(seedDeltaFloor).mockRejectedValueOnce(new Error('db down'));

      await runMailboxSweep();

      expect(listInboxDelta).not.toHaveBeenCalled();
      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalled();
    });

    it('fails closed on a floored row: no usable receivedDateTime is not imported; a delta removal is not a message', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [
          { id: 'no-date' },
          { id: 'bad-date', receivedDateTime: 'not-a-date' },
          { id: 'gone', '@removed': { reason: 'deleted' } },
          fresh('new-1'),
        ],
        deltaLink: 'delta-baseline',
      } as any);

      await runMailboxSweep();
      const warned = warn.mock.calls.find(([line]) => String(line).includes('no usable receivedDateTime'));
      warn.mockRestore();

      expect(enqueuedIds()).toEqual(['new-1']);
      // Named, so the message can be found in the mailbox, and reported, because a
      // message Graph sends without its time is not expected.
      expect(warned?.[1]).toEqual({ id: 'c1', count: 2, messageIds: ['no-date', 'bad-date'] });
      expect(captureException).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('no usable receivedDateTime'),
      }));
      // Neither these nor the removal are "messages already in this inbox": nothing
      // shows they are old.
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 0, completed: true },
      );
    });

    it('caps the message ids it logs', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([baselined()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: Array.from({ length: 30 }, (_, i) => ({ id: `nd-${i}` })),
        deltaLink: 'delta-2',
      } as any);

      await runMailboxSweep();
      const warned = warn.mock.calls.find(([line]) => String(line).includes('no usable receivedDateTime'));
      warn.mockRestore();

      expect((warned?.[1] as { count: number; messageIds: string[] }).count).toBe(30);
      expect((warned?.[1] as { count: number; messageIds: string[] }).messageIds).toHaveLength(20);
      expect(enqueueInboundEmail).not.toHaveBeenCalled();
    });

    it('an expired resumeLink mid-baseline is cleared, and the re-walk is still a floored, counted baseline', async () => {
      const resume = 'https://graph.microsoft.com/next-4';
      vi.mocked(listConnectedMailboxes).mockResolvedValueOnce([connecting({ deltaLink: resume })] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('Graph delta 410'); e.status = 410; throw e; });

      await runMailboxSweep();

      expect(resetDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), resume);
      expect(enqueueInboundEmail).not.toHaveBeenCalled();

      vi.mocked(listConnectedMailboxes).mockResolvedValueOnce([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), backlog('old-2'), fresh('new-1')], deltaLink: 'delta-baseline',
      } as any);
      await runMailboxSweep();

      expect(vi.mocked(listInboxDelta).mock.calls[1]![2]).toBeNull();
      expect(enqueuedIds()).toEqual(['new-1']);
      expect(updateDeltaCursor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }), null, 'delta-baseline', expect.any(Date), expect.anything(),
        { skipped: 2, completed: true },
      );
    });

    it.each([
      ['410 Gone', 410, undefined],
      ['syncStateNotFound', 400, 'syncStateNotFound'],
    ])('a %s with no stored cursor has nothing to clear, so it stops the mailbox instead of looping', async (_label, status, graphCode) => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
        const e: any = new Error(`Graph delta ${status}`); e.status = status; e.graphCode = graphCode; throw e;
      });

      await runMailboxSweep();

      expect(resetDeltaCursor).not.toHaveBeenCalled();
      expect(setConnectedMailboxStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'error', expect.any(String));
    });

    it('an enqueue that fails mid-baseline writes no cursor and no count', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [backlog('old-1'), fresh('new-1'), backlog('old-2')], deltaLink: 'delta-baseline',
      } as any);
      vi.mocked(enqueueInboundEmail).mockRejectedValueOnce(new Error('redis down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runMailboxSweep();
      error.mockRestore();

      expect(markRead).not.toHaveBeenCalled();
      expect(updateDeltaCursor).not.toHaveBeenCalled();
    });

    it('says when a cursor write lost to another sweep, and does not claim the baseline finished', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({ messages: [backlog('old-1')], deltaLink: 'delta-baseline' } as any);
      vi.mocked(updateDeltaCursor).mockResolvedValueOnce(false);

      await runMailboxSweep();
      const lines = info.mock.calls.map(([line]) => String(line));
      info.mockRestore();

      expect(lines.some((line) => line.includes('cursor write lost'))).toBe(true);
      expect(lines.some((line) => line.includes('connect baseline finished'))).toBe(false);
    });

    it('says the baseline finished when its closing write lands', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({ messages: [backlog('old-1')], deltaLink: 'delta-baseline' } as any);
      vi.mocked(updateDeltaCursor).mockResolvedValueOnce(true);

      await runMailboxSweep();
      const finished = info.mock.calls.find(([line]) => String(line).includes('connect baseline finished'));
      info.mockRestore();

      expect(finished?.[1]).toEqual({ id: 'c1', skipped: 1 });
    });

    it('a stale generation mid-baseline writes no cursor and no count', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([connecting()] as any);
      vi.mocked(isConnectedMailboxSnapshotCurrent).mockResolvedValueOnce(false);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({ messages: [backlog('old-1')], deltaLink: 'delta-baseline' } as any);

      await runMailboxSweep();

      expect(enqueueInboundEmail).not.toHaveBeenCalled();
      expect(updateDeltaCursor).not.toHaveBeenCalled();
    });
  });

  // #8308 follow-up: one deadline for the whole Microsoft 365 pass, mailboxes in
  // oldest-attempt order, and every early stop logged with the limit that caused it.
  describe('pass deadline (#8308)', () => {
    const T0 = new Date('2026-10-20T21:00:00Z').getTime();
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });
    afterEach(() => vi.useRealTimers());

    it('is two thirds of the 90 s sweep interval, and a mailbox starts with at least a quarter of it', () => {
      expect(GRAPH_POLL_PASS_BUDGET_MS).toBe(60_000);
      expect(GRAPH_POLL_MIN_MAILBOX_START_MS).toBe(15_000);
      expect(GRAPH_POLL_FAIR_SHARE_MS).toBe(30_000);
      // Shorter than the 45 s minimum gap between back-to-back sweeps reaching a mailbox.
      expect(GRAPH_POLL_ATTEMPT_CLAIM_MS).toBe(30_000);
      expect(GRAPH_POLL_ATTEMPT_CLAIM_MS).toBeLessThan(90_000 - (GRAPH_POLL_PASS_BUDGET_MS - GRAPH_POLL_MIN_MAILBOX_START_MS));
    });

    it('caps every mailbox at the pass deadline, not its own 120 s budget', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(listInboxDelta).mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 20_000);
        return { messages: [], deltaLink: 'd' } as any;
      });

      await runMailboxSweep();
      const deadlines = vi.mocked(listInboxDelta).mock.calls.map((c) => (c[3] as { deadlineAt: number }).deadlineAt);
      expect(deadlines).toEqual([T0 + 60_000, T0 + 60_000]);
    });

    it('stamps each mailbox before its token request, in the order listed', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(listInboxDelta).mockResolvedValue({ messages: [], deltaLink: 'd' } as any);

      await runMailboxSweep();
      expect(vi.mocked(recordPollAttempt).mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
      const stampOrder = vi.mocked(recordPollAttempt).mock.invocationCallOrder[0]!;
      const tokenOrder = vi.mocked(getMailboxToken).mock.invocationCallOrder[0]!;
      expect(stampOrder).toBeLessThan(tokenOrder);
      // Every mailbox: its stamp, then its token, before the next mailbox's stamp.
      const events = [
        ...vi.mocked(recordPollAttempt).mock.invocationCallOrder.map((o) => ({ o, e: 'stamp' })),
        ...vi.mocked(getMailboxToken).mock.invocationCallOrder.map((o) => ({ o, e: 'token' })),
      ].sort((x, y) => x.o - y.o).map((x) => x.e);
      expect(events).toEqual(['stamp', 'token', 'stamp', 'token']);
      expect(vi.mocked(recordPollAttempt).mock.calls.map((c) => c[1])).toEqual([30_000, 30_000]);
    });

    it('stamps a mailbox that then fails, so it moves behind the ones not reached', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('Graph delta 503'); e.status = 503; throw e; });

      await runMailboxSweep();
      expect(recordPollAttempt).toHaveBeenCalledTimes(1);
      expect(recordTransientPollFailure).toHaveBeenCalledTimes(1);
    });

    it('leaves the rest for the next sweep, unstamped and untouched, once too little of the pass is left', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' }), conn({ id: 'c' })] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
        // The first mailbox uses all but 10 s of the pass.
        vi.setSystemTime(T0 + 50_000);
        return { messages: [], deltaLink: 'd' } as any;
      });

      await runMailboxSweep();
      expect(listInboxDelta).toHaveBeenCalledTimes(1);
      expect(getMailboxToken).toHaveBeenCalledTimes(1);
      expect(vi.mocked(recordPollAttempt).mock.calls.map((c) => c[0].id)).toEqual(['a']);
      expect(recordTransientPollFailure).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('pass deadline reached'),
        { left: 2, total: 3, ids: ['b', 'c'], limit: 'pass_deadline' },
      );
    });

    it('still starts a mailbox with exactly the minimum left', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(listInboxDelta)
        .mockImplementationOnce(async () => {
          vi.setSystemTime(T0 + GRAPH_POLL_PASS_BUDGET_MS - GRAPH_POLL_MIN_MAILBOX_START_MS);
          return { messages: [], deltaLink: 'd' } as any;
        })
        .mockResolvedValueOnce({ messages: [], deltaLink: 'd' } as any);

      await runMailboxSweep();
      expect(listInboxDelta).toHaveBeenCalledTimes(2);
    });

    it('skips a mailbox whose stamp fails, so it cannot stay ahead and starve the rest, and polls the next', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(recordPollAttempt).mockRejectedValueOnce(new Error('db blip'));
      vi.mocked(listInboxDelta).mockResolvedValue({ messages: [], deltaLink: 'delta-new' } as any);

      await runMailboxSweep();
      expect(getMailboxToken).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateDeltaCursor).mock.calls.map((c) => c[0].id)).toEqual(['b']);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('could not record the poll attempt'), { id: 'a', err: 'db blip' });
      // Reported and counted, so a stamp that keeps failing shows on its health.
      expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'db blip' }));
      expect(vi.mocked(recordTransientPollFailure).mock.calls.map((c) => c[0].id)).toEqual(['a']);
    });

    it('skips a mailbox whose stamp lands on no row (stale generation) and spends no pass on it', async () => {
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'stale' }), conn({ id: 'b' })] as any);
      vi.mocked(recordPollAttempt).mockResolvedValueOnce(false);
      vi.mocked(listInboxDelta).mockResolvedValue({ messages: [], deltaLink: 'd' } as any);

      await runMailboxSweep();
      expect(getMailboxToken).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateDeltaCursor).mock.calls.map((c) => c[0].id)).toEqual(['b']);
      expect(recordTransientPollFailure).not.toHaveBeenCalled();
    });

    it('checks the minimum again after a slow stamp, starts no token or Graph work, and clears that stamp', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => {
        // The first mailbox leaves 16 s: just over the minimum.
        vi.setSystemTime(T0 + GRAPH_POLL_PASS_BUDGET_MS - 16_000);
        return { messages: [], deltaLink: 'd' } as any;
      });
      vi.mocked(recordPollAttempt)
        .mockImplementationOnce(async () => true)
        .mockImplementationOnce(async () => {
          // The second stamp takes 2 s, leaving 14 s.
          vi.setSystemTime(Date.now() + 2_000);
          return true;
        });

      await runMailboxSweep();
      expect(getMailboxToken).toHaveBeenCalledTimes(1);
      expect(listInboxDelta).toHaveBeenCalledTimes(1);
      expect(recordTransientPollFailure).not.toHaveBeenCalled();
      // Stamped but not started: the stamp is cleared, so 'b' goes first next sweep.
      expect(vi.mocked(releasePollAttempt).mock.calls.map((c) => c[0].id)).toEqual(['b']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('pass deadline reached'),
        { left: 1, total: 2, ids: ['b'], limit: 'pass_deadline' },
      );
    });

    it('defers a late-started mailbox cut off before its first page, without counting it, and clears its stamp so it goes first next sweep', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(listInboxDelta)
        .mockImplementationOnce(async () => {
          // The first mailbox leaves 20 s: enough to start the next, less than a fair share.
          vi.setSystemTime(T0 + GRAPH_POLL_PASS_BUDGET_MS - 20_000);
          return { messages: [], deltaLink: 'd' } as any;
        })
        .mockImplementationOnce(async () => { throw new GraphSweepBudgetError('Graph sweep budget spent'); });

      await runMailboxSweep();
      expect(recordTransientPollFailure).not.toHaveBeenCalled();
      // Without this the fresh stamp would put 'b' back in the same late slot every sweep.
      expect(vi.mocked(releasePollAttempt).mock.calls.map((c) => c[0].id)).toEqual(['b']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('deferred to the next sweep'),
        { id: 'b', shareMs: 20_000, released: true, limit: 'pass_deadline' },
      );
    });

    it('counts a transient failure and reports it when clearing the stamp fails, so it cannot sit unseen in the late slot', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(releasePollAttempt).mockRejectedValueOnce(new Error('db blip'));
      vi.mocked(listInboxDelta)
        .mockImplementationOnce(async () => {
          vi.setSystemTime(T0 + GRAPH_POLL_PASS_BUDGET_MS - 20_000);
          return { messages: [], deltaLink: 'd' } as any;
        })
        .mockImplementationOnce(async () => { throw new GraphSweepBudgetError('Graph sweep budget spent'); });

      await runMailboxSweep();
      expect(vi.mocked(recordTransientPollFailure).mock.calls.map((c) => c[0].id)).toEqual(['b']);
      expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'db blip' }));
    });

    it('still counts a failure when a mailbox with a fair share is cut off before its first page', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => { throw new GraphSweepBudgetError('Graph sweep budget spent'); });

      await runMailboxSweep();
      expect(recordTransientPollFailure).toHaveBeenCalledTimes(1);
    });

    it('counts a mark-read the deadline cut short as skipped with its limit, not as a failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({ messages: [{ id: 'm1' }], deltaLink: 'delta-new' } as any);
      vi.mocked(markRead).mockImplementationOnce(async () => { throw new GraphSweepBudgetError('Graph sweep budget spent'); });

      await runMailboxSweep();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('mark-read failed'), expect.anything());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('left messages unread'), { id: 'c1', count: 1, limit: 'pass_deadline' });
      expect(updateDeltaCursor).toHaveBeenCalledTimes(1);
    });

    it('names the limit when the deadline ends the delta read before its first page', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => { throw new GraphSweepBudgetError('Graph sweep budget spent'); });

      await runMailboxSweep();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('transient'),
        expect.objectContaining({ id: 'c1', limit: 'pass_deadline' }),
      );
    });

    it('leaves the limit off a transient failure Graph caused', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('Graph delta 503'); e.status = 503; throw e; });

      await runMailboxSweep();
      const logged = warn.mock.calls.find((c) => String(c[0]).includes('transient'))![1] as Record<string, unknown>;
      expect(logged).not.toHaveProperty('limit');
    });

    it.each([
      ['page_cap', 'page_cap'],
      ['deadline', 'pass_deadline'],
    ] as const)('says which limit cut a delta round short (%s)', async (resumeReason, expected) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
      vi.mocked(listInboxDelta).mockResolvedValueOnce({
        messages: [{ id: 'm1' }], deltaLink: null, resumeLink: 'https://graph.microsoft.com/next-2', resumeReason,
      } as any);

      await runMailboxSweep();
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('delta round continues'),
        { id: 'c1', messages: 1, limit: expected },
      );
    });
  });

  it('does not count a failure when the poll succeeds', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [], deltaLink: 'delta-new' } as any);

    await runMailboxSweep();
    expect(updateDeltaCursor).toHaveBeenCalledTimes(1);
    expect(recordTransientPollFailure).not.toHaveBeenCalled();
  });

  it('stays connected when the token endpoint is briefly unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(getMailboxToken).mockImplementationOnce(async () => {
      const e: any = new Error('Token acquisition failed (HTTP 503)'); e.status = 503; throw e;
    });

    await runMailboxSweep();
    expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
    expect(listInboxDelta).not.toHaveBeenCalled();
  });

  it('still marks reauth_required when the token endpoint refuses consent (401)', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(getMailboxToken).mockImplementationOnce(async () => {
      const e: any = new Error('Authentication failed'); e.status = 401; throw e;
    });

    await runMailboxSweep();
    expect(setConnectedMailboxStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'reauth_required', expect.any(String));
  });

  it.each([
    ['Graph 404 (mailbox not found)', () => { const e: any = new Error('Graph delta 404'); e.status = 404; return e; }],
    ['a configuration error with no HTTP status', () => new Error('TICKET_MAILBOX_M365_CLIENT_ID/SECRET not configured')],
    // #8308: redirect: 'error' refuses a Graph redirect as a TypeError with no
    // network error code; retrying it forever would hide it.
    ['a refused redirect from Graph', () => new TypeError('fetch failed', { cause: new Error('unexpected redirect') })],
  ])('still marks error on %s', async (_label, makeErr) => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { throw makeErr(); });

    await runMailboxSweep();
    expect(setConnectedMailboxStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'error', expect.any(String));
    expect(recordTransientPollFailure).not.toHaveBeenCalled();
  });

  it('records a sanitized, client-visible reason when the platform mailbox app is not configured', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(getMailboxToken).mockImplementationOnce(async () => { throw new MailboxPlatformNotConfiguredError(); });

    await runMailboxSweep();
    const [, status, message] = vi.mocked(setConnectedMailboxStatus).mock.calls[0]!;
    expect(status).toBe('error');
    // listMailboxConnections only exposes lastError text with this prefix.
    expect(message).toMatch(new RegExp(`^${MAILBOX_VERIFICATION_FAILED}: `));
    expect(message).toContain('TICKET_MAILBOX_M365_CLIENT_ID');
    expect(message).toContain('TICKET_MAILBOX_M365_CLIENT_SECRET');
  });

  it('drops a poll result when disable wins while Graph I/O is in flight', async () => {
    let releaseGraph!: (value: any) => void;
    const graphPaused = new Promise<any>((resolve) => { releaseGraph = resolve; });
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockReturnValue(graphPaused);
    vi.mocked(isConnectedMailboxSnapshotCurrent).mockResolvedValue(false);

    const sweep = runMailboxSweep();
    await vi.waitFor(() => expect(listInboxDelta).toHaveBeenCalledOnce());
    // A lifecycle disable rotates the connection generation before Graph returns.
    releaseGraph({ messages: [{ id: 'stale-message' }], deltaLink: 'stale-delta' });
    await sweep;

    expect(isConnectedMailboxSnapshotCurrent).toHaveBeenCalledWith(expect.objectContaining({
      id: 'c1', consentAttemptId: conn().consentAttemptId,
    }));
    expect(enqueueInboundEmail).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
    expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
  });

  it('does not mark read, enqueue remaining messages, or advance the cursor when disable wins during enqueue', async () => {
    let releaseEnqueue!: () => void;
    const enqueuePaused = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({
      messages: [{ id: 'm1' }, { id: 'm2' }],
      deltaLink: 'stale-delta',
    } as any);
    vi.mocked(enqueueInboundEmail).mockReturnValueOnce(enqueuePaused);
    vi.mocked(isConnectedMailboxSnapshotCurrent)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const sweep = runMailboxSweep();
    await vi.waitFor(() => expect(enqueueInboundEmail).toHaveBeenCalledOnce());
    // The lifecycle disable commits while the first message is being enqueued.
    // The worker must recheck the exact generation before the irreversible
    // Microsoft markRead side effect and before handling another message.
    releaseEnqueue();
    await sweep;

    expect(isConnectedMailboxSnapshotCurrent).toHaveBeenCalledTimes(2);
    expect(markRead).not.toHaveBeenCalled();
    expect(enqueueInboundEmail).toHaveBeenCalledTimes(1);
    expect(updateDeltaCursor).not.toHaveBeenCalled();
  });
});

describe('shutdownTicketMailboxPollWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the worker and queue exactly once after initialize', async () => {
    await initializeTicketMailboxPollWorker();

    await shutdownTicketMailboxPollWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('a second shutdown call is a no-op (handles already nulled)', async () => {
    await initializeTicketMailboxPollWorker();

    await shutdownTicketMailboxPollWorker();
    await shutdownTicketMailboxPollWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when called before initialize', async () => {
    await expect(shutdownTicketMailboxPollWorker()).resolves.toBeUndefined();
    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).not.toHaveBeenCalled();
  });
});
