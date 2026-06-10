import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, selectMock, sendEmailMock, getEmailServiceMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue([]);
  return {
    insertValuesMock,
    selectMock: vi.fn(),
    sendEmailMock: vi.fn().mockResolvedValue(undefined),
    getEmailServiceMock: vi.fn()
  };
});

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/email', () => ({ getEmailService: getEmailServiceMock }));
vi.mock('../db', () => ({
  runWithSystemDbAccess: vi.fn((fn: () => unknown) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => selectMock()) }))
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { insertValuesMock(v); return { returning: vi.fn(() => Promise.resolve([])) }; }) }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id' },
  userNotifications: {},
  users: { id: 'id' }
}));

import { handleTicketEvent } from './ticketNotifyWorker';

describe('handleTicketEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  it('ticket.assigned inserts an in-app notification for the assignee', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    });

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', type: 'ticket', link: '/tickets#T-2026-0042'
    }));
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('skips self-assignment notifications', async () => {
    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-2', payload: { assigneeId: 'u-2' }
    });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('public comment emails the requester', async () => {
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: true }
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'enduser@acme.example',
      subject: expect.stringContaining('T-2026-0042')
    }));
  });

  it('internal comment sends nothing to the requester', async () => {
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: false }
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('works without an email service configured (in-app only)', async () => {
    getEmailServiceMock.mockReturnValue(null);
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);
    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    })).resolves.toBeUndefined();
    expect(insertValuesMock).toHaveBeenCalled();
  });

  it('throws (for BullMQ retry) when the ticket row is not found', async () => {
    // Ticket not yet committed — pre-commit emission contract: worker must retry.
    selectMock.mockResolvedValueOnce([]); // no ticket row

    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 'missing', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    })).rejects.toThrow(/not found/i);
  });

  it('resolves without throwing when email send fails, in-app notification still inserted exactly once', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('SMTP timeout'));
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Email breaks', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    })).resolves.toBeUndefined();

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', type: 'ticket'
    }));
  });
});
