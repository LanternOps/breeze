import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  setConnectedMailboxStatus: vi.fn(async () => {}),
}));
vi.mock('../services/ticketMailbox/mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
vi.mock('../services/ticketMailbox/graphMailClient', async (importOriginal) => ({
  // The real classifier: these tests assert how the sweep reacts to each failure.
  classifyGraphPollError: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).classifyGraphPollError,
  GraphSweepBudgetError: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).GraphSweepBudgetError,
  GRAPH_POLL_SWEEP_BUDGET_MS: (await importOriginal<typeof import('../services/ticketMailbox/graphMailClient')>()).GRAPH_POLL_SWEEP_BUDGET_MS,
  listInboxDelta: vi.fn(),
  markRead: vi.fn(async () => {}),
}));
vi.mock('../services/ticketMailbox/normalizeGraphMessage', () => ({
  normalizeGraphMessage: vi.fn((msg: any, partnerId: string, mailbox: string) => ({
    provider: 'm365', providerMessageId: msg.id, resolvedPartnerId: partnerId, to: mailbox,
    from: 'x@y.com', subject: '', text: '', attachments: [], raw: {},
  })),
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
  setConnectedMailboxStatus,
} from '../services/ticketMailbox/connectionService';
import { getMailboxToken } from '../services/ticketMailbox/mailboxToken';
import { GraphSweepBudgetError, listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';
import {
  GRAPH_POLL_ATTEMPT_CLAIM_MS,
  GRAPH_POLL_MIN_MAILBOX_START_MS,
  GRAPH_POLL_PASS_BUDGET_MS,
  runMailboxSweep,
  initializeTicketMailboxPollWorker,
  shutdownTicketMailboxPollWorker,
} from './ticketMailboxPollWorker';

const conn = (over: Partial<any> = {}) => ({
  id: 'c1', partnerId: 'p1', tenantId: '11111111-1111-1111-1111-111111111111',
  consentAttemptId: '22222222-2222-4222-8222-222222222222',
  mailboxAddress: 'support@a.com', status: 'connected', deltaLink: null, ...over,
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
      null, 'delta-new', expect.any(Date), expect.anything(),
    );
    const enqueueOrder = vi.mocked(enqueueInboundEmail).mock.invocationCallOrder[0]!;
    const cursorOrder = vi.mocked(updateDeltaCursor).mock.invocationCallOrder[0]!;
    expect(enqueueOrder).toBeLessThan(cursorOrder);
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
      null, 'd', expect.any(Date), expect.anything(),
    );
  });

  it('resets the cursor on a 410 Gone and stays connected', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('410'); e.status = 410; throw e; });

    await runMailboxSweep();
    expect(resetDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({
      id: 'c1', consentAttemptId: conn().consentAttemptId,
    }), null);
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
      expect.objectContaining({ id: 'c1' }), null, 'https://graph.microsoft.com/next-7', expect.any(Date), expect.any(Date),
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
    expect(updateDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), null, 'delta-new', expect.any(Date), expect.any(Date));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left messages unread'), { id: 'c1', count: 2, limit: 'pass_deadline' });
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
        { left: 2, total: 3, limit: 'pass_deadline' },
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
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'a' }), conn({ id: 'b' })] as any);
      vi.mocked(recordPollAttempt).mockRejectedValueOnce(new Error('db blip'));
      vi.mocked(listInboxDelta).mockResolvedValue({ messages: [], deltaLink: 'delta-new' } as any);

      await runMailboxSweep();
      expect(getMailboxToken).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateDeltaCursor).mock.calls.map((c) => c[0].id)).toEqual(['b']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record the poll attempt'), { id: 'a', err: 'db blip' });
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

    it('checks the minimum again after a slow stamp and starts no token or Graph work without it', async () => {
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('pass deadline reached'),
        { left: 1, total: 2, limit: 'pass_deadline' },
      );
    });

    it('defers a late-started mailbox the pass deadline cuts off, without counting a failure', async () => {
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('deferred to the next sweep'),
        { id: 'b', shareMs: 20_000, limit: 'pass_deadline' },
      );
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
