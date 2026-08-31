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
  users: { id: 'id', partnerId: 'partner_id', status: 'status', email: 'email' },
  mobileDevices: { userId: 'user_id', fcmToken: 'fcm_token', apnsToken: 'apns_token', platform: 'platform', status: 'status', notificationsEnabled: 'notifications_enabled', quietHours: 'quiet_hours' },
  ticketPushPreferences: { userId: 'user_id', assignedEnabled: 'assigned_enabled', slaScope: 'sla_scope' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] },
}));
// W07 (#3901): the assignee branch now writes through createNotification and
// consults the ticketPush helpers. Stub them so this file keeps testing exactly
// what it is about — the Graph-vs-EmailService fork — and nothing else.
const gfPush = vi.hoisted(() => ({
  createNotification: vi.fn(async () => 'n-1' as string | null),
  loadUserCandidate: vi.fn(async (id: string) => ({ userId: id, partnerId: 'p-1', status: 'active', email: 'tech@msp.example' })),
  loadTicketPushPrefs: vi.fn(async () => ({ assignedEnabled: false, slaScope: 'off' as const })),
  listAnySlaSubscribers: vi.fn(async () => ({ users: [] as unknown[], truncated: false })),
  isAuthorisedForTicket: vi.fn(async () => false),
  admitPush: vi.fn(async () => []),
  resolvePushJobs: vi.fn(async () => []),
}));
vi.mock('../services/userNotifications', () => ({ createNotification: gfPush.createNotification }));
vi.mock('../services/ticketPush', async (orig) => ({
  ...(await orig<typeof import('../services/ticketPush')>()),
  loadUserCandidate: gfPush.loadUserCandidate,
  loadTicketPushPrefs: gfPush.loadTicketPushPrefs,
  listAnySlaSubscribers: gfPush.listAnySlaSubscribers,
  isAuthorisedForTicket: gfPush.isAuthorisedForTicket,
  admitPush: gfPush.admitPush,
  resolvePushJobs: gfPush.resolvePushJobs,
}));
vi.mock('../db/schema/mobile', () => ({
  mobileDevices: { userId: 'user_id', fcmToken: 'fcm_token', apnsToken: 'apns_token', platform: 'platform', status: 'status', notificationsEnabled: 'notifications_enabled', quietHours: 'quiet_hours' },
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
      actorUserId: 'u-1', eventId: 'evt-1', payload: { commentId: 'c-1', isPublic: true },
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
      actorUserId: 'u-1', eventId: 'evt-2', payload: { commentId: 'c-1', isPublic: true },
    });

    expect(sendNewMock).toHaveBeenCalledTimes(1);
    expect(sendNewMock).toHaveBeenCalledWith(MAILBOX, 'cust@x.com', expect.stringContaining('T-1'), expect.any(String));
    expect(sendThreadedMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to EmailService when no verified outbound mailbox resolves', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-1', subject: 'Printer', submitterEmail: 'cust@x.com' }])
      .mockResolvedValueOnce([{ slug: 'acme', settings: {} }]);
    resolveMailboxMock.mockResolvedValue(null);

    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-3', payload: { commentId: 'c-1', isPublic: true },
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(resolveMailboxMock).toHaveBeenCalledWith('t-1', 'p-1');
    expect(sendThreadedMock).not.toHaveBeenCalled();
    expect(sendNewMock).not.toHaveBeenCalled();
  });

  it('NEVER routes assignee/tech notifications through Graph (ticket.assigned uses EmailService)', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-1', subject: 'Printer', submitterEmail: 'cust@x.com' }]) // getTicket
      .mockResolvedValueOnce([{ name: 'Acme' }]); // org name (assignee now via loadUserCandidate)
    // Even if a mailbox WERE connected, the assignee path must never consult it.
    resolveMailboxMock.mockResolvedValue({ ...MAILBOX, originalMessageId: 'orig-1' });

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-4', payload: { assigneeId: 'u-2' },
    });

    expect(sendThreadedMock).not.toHaveBeenCalled();
    expect(sendNewMock).not.toHaveBeenCalled();
    expect(resolveMailboxMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
  });
});
