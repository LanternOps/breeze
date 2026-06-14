import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, selectMock, updateSetMock, sendEmailMock, getEmailServiceMock, withSystemDbAccessContextMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue([]);
  const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());
  return {
    insertValuesMock,
    selectMock: vi.fn(),
    updateSetMock: vi.fn(),
    sendEmailMock: vi.fn().mockResolvedValue(undefined),
    getEmailServiceMock: vi.fn(),
    withSystemDbAccessContextMock
  };
});

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/email', () => ({ getEmailService: getEmailServiceMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
// outboundThreading.ts reads TICKETS_INBOUND_DOMAIN via getConfig(). The specifier
// from this file (in jobs/) is '../config/validate', which resolves to the same
// apps/api/src/config/validate.ts that outboundThreading imports as '../../config/validate'.
vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../db', () => ({
  // Correct mock name: the worker uses withSystemDbAccessContext (not runWithSystemDbAccess)
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => selectMock()) }))
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { insertValuesMock(v); return { returning: vi.fn(() => Promise.resolve([])) }; }) })),
    // anchor-stamp UPDATE: db.update(tickets).set({...}).where(...)
    update: vi.fn(() => ({ set: vi.fn((v: unknown) => { updateSetMock(v); return { where: vi.fn(() => Promise.resolve([])) }; }) }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id' },
  partners: { id: 'id', slug: 'slug', settings: 'settings' },
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
    updateSetMock.mockReset();
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

  it('inbound public comment does NOT email the requester (echo-guard)', async () => {
    // An inbound comment originates FROM the requester's own email — emailing them
    // back would create a mail loop. The guard is: isPublic && !inbound.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: true, inbound: true }
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('non-inbound public comment still emails the requester', async () => {
    // Sanity-check that the guard only fires when inbound:true.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-2', isPublic: true, inbound: false }
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'enduser@acme.example'
    }));
  });

  it('threads the outbound public-comment reply (Message-ID/In-Reply-To/Reply-To + subject token)', async () => {
    // Two selects in order: the ticket row, then the partner (slug + settings) row.
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: null }])
      .mockResolvedValueOnce([{ slug: 'acme', settings: {} }]);

    await handleTicketEvent({
      type: 'ticket.commented',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { commentId: 'c-9', isPublic: true /* inbound omitted = false */ }
    } as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { to: string; subject: string; replyTo?: string; headers?: Record<string, string> };
    expect(arg.to).toBe('jane@x.com');
    expect(arg.subject).toBe('[T-2026-0001] New reply: printer down');
    expect(arg.replyTo).toBe('acme@tickets.example.com');
    expect(arg.headers!['Message-ID']).toBe('<ticket-t-1-c-9@tickets.example.com>');
    expect(arg.headers!['In-Reply-To']).toBe('<ticket-t-1@tickets.example.com>');
    expect(arg.headers!['References']).toBe('<ticket-t-1@tickets.example.com>');

    // The thread anchor was stamped onto the ticket (first reply, emailThreadKey was null).
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      emailThreadKey: '<ticket-t-1@tickets.example.com>'
    }));
  });

  it('honors the partner self-hosted inbound override as Reply-To', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: null }])
      .mockResolvedValueOnce([{ slug: 'acme', settings: { ticketing: { inbound: { address: 'support@helpdesk.theirmsp.com' } } } }]);

    await handleTicketEvent({
      type: 'ticket.commented',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { commentId: 'c-9', isPublic: true }
    } as never);

    const arg = sendEmailMock.mock.calls[0]![0] as { replyTo?: string };
    expect(arg.replyTo).toBe('support@helpdesk.theirmsp.com');
  });

  it('does NOT re-stamp emailThreadKey when the ticket already has one', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: '<existing@x>' }])
      .mockResolvedValueOnce([{ slug: 'acme', settings: {} }]);

    await handleTicketEvent({
      type: 'ticket.commented',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { commentId: 'c-9', isPublic: true }
    } as never);

    expect(updateSetMock).not.toHaveBeenCalled();
    // But In-Reply-To/References still point at the deterministic ticket anchor.
    const arg = sendEmailMock.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(arg.headers!['In-Reply-To']).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('does NOT thread the Resolved status-changed email (no headers / no Reply-To / no anchor collision)', async () => {
    // Only ONE select (ticket) — no partner lookup happens because commentId is absent.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: null }]);

    await handleTicketEvent({
      type: 'ticket.status_changed',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { from: 'open', to: 'resolved', resolutionNote: null }
    } as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { subject: string; headers?: Record<string, string>; replyTo?: string };
    expect(arg.subject).toBe('[T-2026-0001] Resolved: printer down');
    expect(arg.headers).toBeUndefined();   // no Message-ID → no collision with the autoresponse anchor
    expect(arg.replyTo).toBeUndefined();
    // And no anchor was stamped on the Resolved path.
    expect(updateSetMock).not.toHaveBeenCalled();
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

  // ── ticket.sla_breached fan-out tests ──────────────────────────────────────

  it('ticket.sla_breached notifies the assignee in-app and by email', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0001', subject: 'Printer', submitterEmail: 'requester@acme.example' }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: 'u-2' }
    });

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2',
      orgId: 'o-1',
      type: 'ticket',
      priority: 'normal',
      title: 'SLA breached: T-2026-0001',
      message: expect.stringContaining('response'),
      link: '/tickets#T-2026-0001'
    }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'tech@msp.example',
      subject: 'SLA breached: T-2026-0001 — Printer',
      html: expect.stringContaining('response')
    }));
  });

  it('ticket.sla_breached with no assignee creates no notification and no email', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0001', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([]); // assignee user row absent (deleted user)

    await expect(handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, payload: { target: 'resolution', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: 'u-deleted' }
    })).resolves.toBeUndefined();

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    selectMock.mockReset();

    await expect(handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: null }
    })).resolves.toBeUndefined();

    expect(selectMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.sla_breached throws when the ticket row is missing (retryable, pre-commit contract)', async () => {
    selectMock.mockResolvedValueOnce([]); // no ticket row

    await expect(handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 'missing', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: 'u-2' }
    })).rejects.toThrow(/not found/i);
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

  it('ticket.updated is an explicit no-op — no ticket lookup, no insert, no email', async () => {
    await handleTicketEvent({
      type: 'ticket.updated', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { changed: ['subject', 'priority'] }
    });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
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
