import { describe, it, expect, vi, beforeEach } from 'vitest';

// Worker CAS helpers self-wrap so FORCE-RLS writes run under system scope. This is a unit test
// with no database, so make the helpers pass-throughs that just invoke their
// callback — the real context behavior is exercised by the cursor RLS
// integration test (ticketMailboxCursor.rls.integration.test.ts).
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => any) => fn(),
  withSystemDbAccessContext: (fn: () => any) => fn(),
}));

vi.mock('../services/ticketMailbox/connectionService', () => ({
  isConnectedMailboxSnapshotCurrent: vi.fn(async () => true),
  listConnectedMailboxes: vi.fn(),
  updateDeltaCursor: vi.fn(async () => {}),
  resetDeltaCursor: vi.fn(async () => {}),
  setConnectedMailboxStatus: vi.fn(async () => {}),
}));
vi.mock('../services/ticketMailbox/mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
vi.mock('../services/ticketMailbox/graphMailClient', () => ({
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
  setConnectedMailboxStatus,
} from '../services/ticketMailbox/connectionService';
import { getMailboxToken } from '../services/ticketMailbox/mailboxToken';
import { listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';
import { runMailboxSweep } from './ticketMailboxPollWorker';

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
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(updateDeltaCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', consentAttemptId: conn().consentAttemptId }),
      'delta-new', expect.any(Date), expect.anything(),
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
      'd', expect.any(Date), expect.anything(),
    );
  });

  it('resets the cursor on a 410 Gone and stays connected', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('410'); e.status = 410; throw e; });

    await runMailboxSweep();
    expect(resetDeltaCursor).toHaveBeenCalledWith(expect.objectContaining({
      id: 'c1', consentAttemptId: conn().consentAttemptId,
    }));
    expect(setConnectedMailboxStatus).not.toHaveBeenCalled();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
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
});
