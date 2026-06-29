import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors ticketNotifyWorker.test.ts scaffolding, plus configurable mocks for the
// M365 mailbox resolver and Graph senders so we can assert the customer-facing fork.
const {
  insertValuesMock, selectMock, updateSetMock, sendEmailMock, getEmailServiceMock,
  withSystemDbAccessContextMock, resolveMailboxMock, sendThreadedMock, sendNewMock,
} = vi.hoisted(() => ({
  insertValuesMock: vi.fn().mockResolvedValue([]),
  selectMock: vi.fn(),
  updateSetMock: vi.fn(),
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  getEmailServiceMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn((fn: () => unknown) => fn()),
  resolveMailboxMock: vi.fn(),
  sendThreadedMock: vi.fn(async () => {}),
  sendNewMock: vi.fn(async () => {}),
}));

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/email', () => ({ getEmailService: getEmailServiceMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => selectMock()) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { insertValuesMock(v); return { returning: vi.fn(() => Promise.resolve([])) }; }) })),
    update: vi.fn(() => ({ set: vi.fn((v: unknown) => { updateSetMock(v); return { where: vi.fn(() => Promise.resolve([])) }; }) })),
  },
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id' },
  partners: { id: 'id', slug: 'slug', name: 'name', settings: 'settings' },
  organizations: { id: 'id', name: 'name' },
  userNotifications: {},
  users: { id: 'id' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] },
}));
vi.mock('../services/ticketMailbox/resolveOutboundMailbox', () => ({ resolveOutboundMailbox: resolveMailboxMock }));
vi.mock('../services/ticketMailbox/graphReplySender', () => ({ sendThreadedReply: sendThreadedMock, sendNewMail: sendNewMock }));

import { handleTicketEvent } from './ticketNotifyWorker';

const MAILBOX = { tenantId: '11111111-1111-1111-1111-111111111111', mailbox: 'support@a.com' };

describe('ticketNotifyWorker M365 Graph fork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    resolveMailboxMock.mockReset();
    withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  it('routes a threaded public reply through sendThreadedReply, not EmailService', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-1', subject: 'Printer', submitterEmail: 'cust@x.com' }]) // getTicket
      .mockResolvedValueOnce([{ slug: 'acme', settings: {} }]); // partner (replyTo)
    resolveMailboxMock.mockResolvedValue({ ...MAILBOX, originalMessageId: 'orig-1' });

    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: true },
    });

    expect(sendThreadedMock).toHaveBeenCalledTimes(1);
    expect(sendThreadedMock).toHaveBeenCalledWith(MAILBOX, 'orig-1', expect.any(String));
    expect(sendNewMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('uses sendNewMail when the mailbox is connected but there is no original message id', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-1', subject: 'Printer', submitterEmail: 'cust@x.com' }])
      .mockResolvedValueOnce([{ slug: 'acme', settings: {} }]);
    resolveMailboxMock.mockResolvedValue({ ...MAILBOX, originalMessageId: null });

    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: true },
    });

    expect(sendNewMock).toHaveBeenCalledTimes(1);
    expect(sendNewMock).toHaveBeenCalledWith(MAILBOX, 'cust@x.com', expect.stringContaining('T-1'), expect.any(String));
    expect(sendThreadedMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to EmailService for a public reply when the partner has no connected mailbox', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-1', subject: 'Printer', submitterEmail: 'cust@x.com' }])
      .mockResolvedValueOnce([{ slug: 'acme', settings: {} }]);
    resolveMailboxMock.mockResolvedValue(null);

    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: true },
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendThreadedMock).not.toHaveBeenCalled();
    expect(sendNewMock).not.toHaveBeenCalled();
  });

  it('NEVER routes assignee/tech notifications through Graph (ticket.assigned uses EmailService)', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-1', subject: 'Printer', submitterEmail: 'cust@x.com' }]) // getTicket
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]); // assignee user
    // Even if a mailbox WERE connected, the assignee path must never consult it.
    resolveMailboxMock.mockResolvedValue({ ...MAILBOX, originalMessageId: 'orig-1' });

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' },
    });

    expect(sendThreadedMock).not.toHaveBeenCalled();
    expect(sendNewMock).not.toHaveBeenCalled();
    expect(resolveMailboxMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
  });
});
