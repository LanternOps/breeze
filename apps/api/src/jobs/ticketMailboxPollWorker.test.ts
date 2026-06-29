import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/ticketMailbox/connectionService', () => ({
  listConnectedMailboxes: vi.fn(),
  updateDeltaCursor: vi.fn(async () => {}),
  resetDeltaCursor: vi.fn(async () => {}),
  setConnectionStatus: vi.fn(async () => {}),
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

import { listConnectedMailboxes, updateDeltaCursor, resetDeltaCursor, setConnectionStatus } from '../services/ticketMailbox/connectionService';
import { listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';
import { runMailboxSweep } from './ticketMailboxPollWorker';

const conn = (over: Partial<any> = {}) => ({
  id: 'c1', partnerId: 'p1', tenantId: '11111111-1111-1111-1111-111111111111',
  mailboxAddress: 'support@a.com', status: 'connected', deltaLink: null, ...over,
});

describe('runMailboxSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues each new message, marks it read, then persists the new deltaLink', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockResolvedValue({ messages: [{ id: 'm1' }, { id: 'm2' }], deltaLink: 'delta-new' } as any);

    await runMailboxSweep();

    expect(enqueueInboundEmail).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(updateDeltaCursor).toHaveBeenCalledWith('c1', 'delta-new', expect.any(Date), expect.anything());
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
    expect(setConnectionStatus).not.toHaveBeenCalledWith('c1', 'p1', 'reauth_required', expect.anything());
  });

  it('marks reauth_required on a 401 from Graph and isolates per mailbox', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn({ id: 'bad' }), conn({ id: 'good' })] as any);
    vi.mocked(listInboxDelta)
      .mockImplementationOnce(async () => { const e: any = new Error('401'); e.status = 401; throw e; })
      .mockResolvedValueOnce({ messages: [], deltaLink: 'd' } as any);

    await runMailboxSweep();
    expect(setConnectionStatus).toHaveBeenCalledWith('bad', 'p1', 'reauth_required', expect.any(String));
    expect(updateDeltaCursor).toHaveBeenCalledWith('good', 'd', expect.any(Date), expect.anything());
  });

  it('resets the cursor on a 410 Gone and stays connected', async () => {
    vi.mocked(listConnectedMailboxes).mockResolvedValue([conn()] as any);
    vi.mocked(listInboxDelta).mockImplementationOnce(async () => { const e: any = new Error('410'); e.status = 410; throw e; });

    await runMailboxSweep();
    expect(resetDeltaCursor).toHaveBeenCalledWith('c1');
    expect(setConnectionStatus).not.toHaveBeenCalled();
    expect(updateDeltaCursor).not.toHaveBeenCalled();
  });
});
