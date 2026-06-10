import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, selectMock, sendEmailMock, getEmailServiceMock, withSystemDbAccessContextMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue([]);
  const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());
  return {
    insertValuesMock,
    selectMock: vi.fn(),
    sendEmailMock: vi.fn().mockResolvedValue(undefined),
    getEmailServiceMock: vi.fn(),
    withSystemDbAccessContextMock
  };
});

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/email', () => ({ getEmailService: getEmailServiceMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({
  // Correct mock name: the worker uses withSystemDbAccessContext (not runWithSystemDbAccess)
  withSystemDbAccessContext: withSystemDbAccessContextMock,
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
  users: { id: 'id' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));

import { handleTicketEvent } from './ticketNotifyWorker';

describe('handleTicketEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  it('invokes withSystemDbAccessContext for job-processing path', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    });

    expect(withSystemDbAccessContextMock).toHaveBeenCalled();
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

  // ── FK contract: assignee-first ordering ───────────────────────────────────

  it('resolves silently when assignee user row is missing — no insert, no email, no throw', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([]); // assignee user row absent (deleted user)

    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-deleted' }
    })).resolves.toBeUndefined();

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── ticket.status_changed fan-out tests ────────────────────────────────────

  it('ticket.status_changed to resolved sends email with internal number and HTML-escaped resolution note', async () => {
    const xssNote = '<script>alert("xss")</script>';
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: 'user@acme.example'
    }]);

    await handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { from: 'open', to: 'resolved', resolutionNote: xssNote }
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0]![0] as { to: string; subject: string; html: string };
    expect(call.to).toBe('user@acme.example');
    expect(call.subject).toContain('T-2026-0099');
    // HTML-escaped entities must appear; raw tag must NOT
    expect(call.html).toContain('&lt;script&gt;');
    expect(call.html).not.toContain('<script>');
  });

  it('ticket.status_changed to pending sends no email', async () => {
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: 'user@acme.example'
    }]);

    await handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { from: 'open', to: 'pending', resolutionNote: null }
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.status_changed to resolved with null submitterEmail resolves without sending email', async () => {
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: null
    }]);

    await expect(handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { from: 'open', to: 'resolved', resolutionNote: 'All done' }
    })).resolves.toBeUndefined();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.created with assigneeId fans out in-app row and email (same as ticket.assigned)', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-2', orgId: 'o-1', internalNumber: 'T-2026-0100', subject: 'New ticket', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-3', email: 'assignee@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.created', ticketId: 't-2', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { internalNumber: 'T-2026-0100', subject: 'New ticket', assigneeId: 'u-3', source: 'manual' }
    });

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-3', type: 'ticket', link: '/tickets#T-2026-0100'
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'assignee@msp.example',
      subject: expect.stringContaining('T-2026-0100')
    }));
  });
});
