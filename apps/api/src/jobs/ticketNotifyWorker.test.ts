import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, selectMock, updateSetMock, sendEmailMock, getEmailServiceMock, withSystemDbAccessContextMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue([]);
  // Records context enter/exit so tests can prove every push dispatch happens
  // AFTER the system DB context closes (#1105).
  const withSystemDbAccessContextMock = vi.fn(async (fn: () => unknown) => {
    push.order.push('ctx:enter');
    const r = await fn();
    push.order.push('ctx:exit');
    return r;
  });
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
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: sentry.captureException }));
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
  partners: { id: 'id', slug: 'slug', name: 'name', settings: 'settings' },
  organizations: { id: 'id', name: 'name' },
  userNotifications: {},
  users: { id: 'id', partnerId: 'partner_id', status: 'status', email: 'email' },
  mobileDevices: { userId: 'user_id', fcmToken: 'fcm_token', apnsToken: 'apns_token', platform: 'platform', status: 'status', notificationsEnabled: 'notifications_enabled', quietHours: 'quiet_hours' },
  ticketPushPreferences: { userId: 'user_id', assignedEnabled: 'assigned_enabled', slaScope: 'sla_scope' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));
// M365 mailbox routing: default to "no connected mailbox" so these existing tests
// exercise the unchanged EmailService path (and don't consume a selectMock read).
vi.mock('../services/ticketMailbox/resolveOutboundMailbox', () => ({
  resolveOutboundMailbox: vi.fn(async () => null)
}));
vi.mock('../services/ticketMailbox/graphReplySender', () => ({
  sendThreadedReply: vi.fn(async () => {}),
  sendNewMail: vi.fn(async () => {})
}));

// ── W07 (#3901): push fan-out collaborators ────────────────────────────────
const push = vi.hoisted(() => ({
  createNotification: vi.fn(async (_input: { userId: string; dedupeKey?: string }) => 'n-1' as string | null),
  loadUserCandidate: vi.fn(async (id: string) => ({ userId: id, partnerId: 'p-1', status: 'active', email: 'tech@msp.example' })),
  loadTicketPushPrefs: vi.fn(async () => ({ assignedEnabled: true, slaScope: 'owned' as 'off' | 'owned' | 'any' })),
  listAnySlaSubscribers: vi.fn(async () => ({ users: [] as unknown[], truncated: false })),
  isAuthorisedForTicket: vi.fn(async () => true),
  admitPush: vi.fn(async (pending: { userId: string; spec: unknown }[]) => pending),
  resolvePushJobs: vi.fn(async (pending: { userId: string; spec: unknown }[]) =>
    pending.map((p) => ({ tokens: [{ token: 'tok', platform: 'ios', provider: 'apns' }], spec: p.spec }))),
  dispatchPushToTokens: vi.fn(async () => ({ tokensFound: 1, dispatched: 1, errors: 0 })),
  order: [] as string[],
}));
vi.mock('../services/userNotifications', () => ({ createNotification: push.createNotification }));
vi.mock('../services/ticketPush', async (orig) => {
  const actual = await orig<typeof import('../services/ticketPush')>();
  return {
    ...actual,
    loadUserCandidate: push.loadUserCandidate,
    loadTicketPushPrefs: push.loadTicketPushPrefs,
    listAnySlaSubscribers: push.listAnySlaSubscribers,
    isAuthorisedForTicket: push.isAuthorisedForTicket,
    admitPush: (...a: [never]) => { push.order.push('admit'); return push.admitPush(...a); },
    resolvePushJobs: (...a: [never]) => { push.order.push('tokens'); return push.resolvePushJobs(...a); },
  };
});
vi.mock('../services/expoPush', async (orig) => {
  const actual = await orig<typeof import('../services/expoPush')>();
  return {
    ...actual,
    dispatchPushToTokens: (...a: unknown[]) => { push.order.push('dispatch'); return push.dispatchPushToTokens(...(a as [])); },
  };
});

import { handleTicketEvent } from './ticketNotifyWorker';

describe('handleTicketEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateSetMock.mockReset();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => unknown) => fn());
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  it('invokes withSystemDbAccessContext for job-processing path', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-1', payload: { assigneeId: 'u-2' }
    });

    expect(withSystemDbAccessContextMock).toHaveBeenCalled();
  });

  it('ticket.assigned inserts an in-app notification for the assignee', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-2', payload: { assigneeId: 'u-2' }
    });

    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', type: 'ticket', link: '/tickets#T-2026-0042'
    }));
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('skips self-assignment notifications', async () => {
    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-2', eventId: 'evt-3', payload: { assigneeId: 'u-2' }
    });
    expect(push.createNotification).not.toHaveBeenCalled();
  });

  it('public comment emails the requester', async () => {
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-4', payload: { commentId: 'c-1', isPublic: true }
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
      actorUserId: 'u-1', eventId: 'evt-5', payload: { commentId: 'c-1', isPublic: false }
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('inbound public comment does NOT email the requester (echo-guard)', async () => {
    // An inbound comment originates FROM the requester's own email — emailing them
    // back would create a mail loop. The guard is: isPublic && !inbound.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-6', payload: { commentId: 'c-1', isPublic: true, inbound: true }
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('non-inbound public comment still emails the requester', async () => {
    // Sanity-check that the guard only fires when inbound:true.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-7', payload: { commentId: 'c-2', isPublic: true, inbound: false }
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
      actorUserId: 'u-1', eventId: 'evt-8',
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
      actorUserId: 'u-1', eventId: 'evt-9',
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
      actorUserId: 'u-1', eventId: 'evt-10',
      payload: { commentId: 'c-9', isPublic: true }
    } as never);

    expect(updateSetMock).not.toHaveBeenCalled();
    // But In-Reply-To/References still point at the deterministic ticket anchor.
    const arg = sendEmailMock.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(arg.headers!['In-Reply-To']).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('does NOT thread the Resolved status-changed email (no headers / no Reply-To / no anchor collision)', async () => {
    // Only ONE select (ticket) — no partner lookup happens because commentId is absent.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: null, status: 'resolved' }]);

    await handleTicketEvent({
      type: 'ticket.status_changed',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-11',
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

  it('sends a threaded, Auto-Submitted autoresponse on ticket.autoresponse', async () => {
    // Three selects in order: the ticket row, the partner (slug + settings) row, then the org row.
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: null }])
      .mockResolvedValueOnce([{ slug: 'acme', name: 'Acme MSP', settings: {} }])
      .mockResolvedValueOnce([{ name: 'Jane Co' }]);

    await handleTicketEvent({
      type: 'ticket.autoresponse',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-12',
      payload: { to: 'jane@x.com', internalNumber: 'T-2026-0001', subject: 'printer down' }
    } as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { to: string; subject: string; replyTo?: string; headers?: Record<string, string> };
    expect(arg.to).toBe('jane@x.com');
    expect(arg.subject).toBe('[T-2026-0001] We received your request: printer down');
    expect(arg.replyTo).toBe('acme@tickets.example.com');
    expect(arg.headers!['Auto-Submitted']).toBe('auto-replied');
    expect(arg.headers!['Message-ID']).toBe('<ticket-t-1@tickets.example.com>');
  });

  it('renders the partner custom auto-reply with ticket/org/partner merge variables', async () => {
    // ticket row carries submitterName; partner has a custom subject+body template; org name resolves.
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterName: 'Jane Doe', submitterEmail: 'jane@x.com', emailThreadKey: null }])
      .mockResolvedValueOnce([{ slug: 'acme', name: 'Acme MSP', settings: { ticketing: { inbound: {
        autoresponseSubject: 'Re: {{ticket_subject}} [{{ticket_number}}]',
        autoresponseBody: 'Hi {{requester_name}} at {{org_name}} — {{partner_name}} got it ({{requester_email}}).',
      } } } }])
      .mockResolvedValueOnce([{ name: 'Jane Co' }]);

    await handleTicketEvent({
      type: 'ticket.autoresponse',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-13',
      payload: { to: 'jane@x.com', internalNumber: 'T-2026-0001', subject: 'printer down' }
    } as never);

    const arg = sendEmailMock.mock.calls[0]![0] as { subject: string; html: string };
    expect(arg.subject).toBe('Re: printer down [T-2026-0001]');
    // Every variable resolves from its real source: submitterName, org row, partner.name, payload.to.
    expect(arg.html).toContain('Hi Jane Doe at Jane Co — Acme MSP got it (jane@x.com).');
  });

  it('autoresponse honors the partner self-hosted inbound override as Reply-To', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer down', submitterEmail: 'jane@x.com', emailThreadKey: null }])
      .mockResolvedValueOnce([{ slug: 'acme', name: 'Acme MSP', settings: { ticketing: { inbound: { address: 'support@helpdesk.theirmsp.com' } } } }])
      .mockResolvedValueOnce([{ name: 'Jane Co' }]);

    await handleTicketEvent({
      type: 'ticket.autoresponse',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-14',
      payload: { to: 'jane@x.com', internalNumber: 'T-2026-0001', subject: 'printer down' }
    } as never);

    const arg = sendEmailMock.mock.calls[0]![0] as { replyTo?: string };
    expect(arg.replyTo).toBe('support@helpdesk.theirmsp.com');
  });

  it('works without an email service configured (in-app only)', async () => {
    getEmailServiceMock.mockReturnValue(null);
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);
    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-15', payload: { assigneeId: 'u-2' }
    })).resolves.toBeUndefined();
    expect(push.createNotification).toHaveBeenCalled();
  });

  it('throws (for BullMQ retry) when the ticket row is not found', async () => {
    // Ticket not yet committed — pre-commit emission contract: worker must retry.
    selectMock.mockResolvedValueOnce([]); // no ticket row

    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 'missing', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-16', payload: { assigneeId: 'u-2' }
    })).rejects.toThrow(/not found/i);
  });

  it('resolves without throwing when email send fails, in-app notification still inserted exactly once', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('SMTP timeout'));
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Email breaks', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-17', payload: { assigneeId: 'u-2' }
    })).resolves.toBeUndefined();

    expect(push.createNotification).toHaveBeenCalledTimes(1);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', type: 'ticket'
    }));
  });

  // ── FK contract: assignee-first ordering ───────────────────────────────────

  it('resolves silently when assignee user row is missing — no insert, no email, no throw', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }]);
    push.loadUserCandidate.mockResolvedValueOnce(null as never); // deleted user

    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-18', payload: { assigneeId: 'u-deleted' }
    })).resolves.toBeUndefined();

    expect(push.createNotification).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ── ticket.sla_breached fan-out tests ──────────────────────────────────────

  it('ticket.sla_breached notifies the assignee in-app and by email', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0001', subject: 'Printer', submitterEmail: 'requester@acme.example' }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-19', payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: 'u-2' }
    });

    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({
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

  it('ticket.sla_breached with a deleted assignee and no subscribers creates no notification and no email', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0001', subject: 'Printer', submitterEmail: null }]);
    push.loadUserCandidate.mockResolvedValueOnce(null as never); // deleted user

    await expect(handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-20', payload: { target: 'resolution', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: 'u-deleted' }
    })).resolves.toBeUndefined();

    expect(push.createNotification).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    selectMock.mockReset();
    // W07: an UNASSIGNED breach is no longer an early return — the 'any'
    // subscriber fan-out still runs, so the ticket row IS read. With no
    // subscribers, nobody is notified.
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0001', subject: 'Printer', submitterEmail: null }]);

    await expect(handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-21', payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: null }
    })).resolves.toBeUndefined();

    expect(push.createNotification).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.sla_breached throws when the ticket row is missing (retryable, pre-commit contract)', async () => {
    selectMock.mockResolvedValueOnce([]); // no ticket row

    await expect(handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: 'missing', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: null, eventId: 'evt-22', payload: { target: 'response', internalNumber: 'T-2026-0001', subject: 'Printer', assigneeId: 'u-2' }
    })).rejects.toThrow(/not found/i);
  });

  // ── ticket.status_changed fan-out tests ────────────────────────────────────

  it('ticket.status_changed to resolved sends email with internal number and HTML-escaped resolution note', async () => {
    const xssNote = '<script>alert("xss")</script>';
    // #3828 wave-6-3 task 2: resolutionNote no longer rides the event payload
    // — the worker reads it off THIS ticket row instead.
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: 'user@acme.example', resolutionNote: xssNote, status: 'resolved'
    }]);

    await handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-23', payload: { from: 'open', to: 'resolved' }
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
      actorUserId: 'u-1', eventId: 'evt-24', payload: { changed: ['subject', 'priority'] }
    });
    expect(selectMock).not.toHaveBeenCalled();
    expect(push.createNotification).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.status_changed to pending sends no email', async () => {
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: 'user@acme.example'
    }]);

    await handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-25', payload: { from: 'open', to: 'pending' }
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.status_changed to resolved with null submitterEmail resolves without sending email', async () => {
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: null, resolutionNote: 'All done', status: 'resolved'
    }]);

    await expect(handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-26', payload: { from: 'open', to: 'resolved' }
    })).resolves.toBeUndefined();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.status_changed to resolved retries when the fetched ticket row is STALE (status not yet resolved) — read-your-own-write race guard', async () => {
    // Pre-commit emission contract extends to status changes: the row can exist
    // (unlike the "missing row" case) but still be stale relative to the event
    // that queued this job — e.g. the requester's transaction hasn't committed
    // yet, or (worse) a reopen->re-resolve race where resolution_note still
    // holds the PREVIOUS resolution text. The worker must retry, not email.
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: 'user@acme.example', resolutionNote: null, status: 'open'
    }]);

    await expect(handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-27', payload: { from: 'open', to: 'resolved' }
    })).rejects.toThrow(/not yet visible/i);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('ticket.status_changed to resolved does NOT throw when the row has already advanced past resolved (resolve→closed race within the retry window) — composes email from the committed resolutionNote', async () => {
    // The transition described by THIS event (open -> resolved) already committed —
    // the row has simply moved on again (resolved -> closed) by the time this job
    // runs. That is a committed, not a stale, read: status !== payload.from proves
    // the resolve happened, so the guard must not conflate this with the
    // not-yet-committed case (previous test) and must send using the
    // resolutionNote written by that committed resolve.
    selectMock.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0099', subject: 'Slow VPN',
      submitterEmail: 'user@acme.example', resolutionNote: 'Fixed and closed', status: 'closed'
    }]);

    await expect(handleTicketEvent({
      type: 'ticket.status_changed', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-28', payload: { from: 'open', to: 'resolved' }
    })).resolves.toBeUndefined();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(call.html).toContain('Fixed and closed');
  });

  it('ticket.created with assigneeId fans out in-app row and email (same as ticket.assigned)', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-2', orgId: 'o-1', internalNumber: 'T-2026-0100', subject: 'New ticket', submitterEmail: null }])
      .mockResolvedValueOnce([{ name: 'Acme' }]); // getOrgName for the push spec
    // W07: the assignee row now comes from ticketPush.loadUserCandidate, not a
    // raw select, so its email is supplied here.
    push.loadUserCandidate.mockResolvedValueOnce({ userId: 'u-3', partnerId: 'p-1', status: 'active', email: 'assignee@msp.example' });

    await handleTicketEvent({
      type: 'ticket.created', ticketId: 't-2', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'evt-29', payload: { internalNumber: 'T-2026-0100', assigneeId: 'u-3', source: 'manual' }
    });

    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-3', type: 'ticket', link: '/tickets#T-2026-0100'
    }));
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'assignee@msp.example',
      subject: expect.stringContaining('T-2026-0100')
    }));
  });
});

// ---------------------------------------------------------------------------
// W07 (#3901): ticket push fan-out
// ---------------------------------------------------------------------------

const TICKET = { id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null };

const assigned = (over: Record<string, unknown> = {}) => ({
  type: 'ticket.assigned' as const, ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1', actorUserId: 'u-1',
  eventId: 'evt-1', payload: { assigneeId: 'u-2' }, ...over,
});

function resetPushMocks(): void {
  vi.clearAllMocks();
  selectMock.mockReset();
  push.order.length = 0;
  push.createNotification.mockResolvedValue('n-1');
  push.loadUserCandidate.mockImplementation(async (id: string) => ({ userId: id, partnerId: 'p-1', status: 'active', email: 'tech@msp.example' }));
  push.loadTicketPushPrefs.mockResolvedValue({ assignedEnabled: true, slaScope: 'owned' });
  push.listAnySlaSubscribers.mockResolvedValue({ users: [], truncated: false });
  push.isAuthorisedForTicket.mockResolvedValue(true);
  push.admitPush.mockImplementation(async (pending: { userId: string; spec: unknown }[]) => pending);
  push.resolvePushJobs.mockImplementation(async (pending: { userId: string; spec: unknown }[]) =>
    pending.map((p) => ({ tokens: [{ token: 'tok', platform: 'ios', provider: 'apns' }], spec: p.spec })));
  push.dispatchPushToTokens.mockResolvedValue({ tokensFound: 1, dispatched: 1, errors: 0 });
  withSystemDbAccessContextMock.mockImplementation(async (fn: () => unknown) => {
    push.order.push('ctx:enter');
    const r = await fn();
    push.order.push('ctx:exit');
    return r;
  });
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
}

describe('ticket push fan-out (W07)', () => {
  beforeEach(() => {
    resetPushMocks();
    // getTicket, then getOrgName.
    selectMock.mockResolvedValueOnce([TICKET]).mockResolvedValueOnce([{ name: 'Acme' }]);
  });

  it('assigned: writes the in-app row with the dedupe key, then pushes after the context exits', async () => {
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', orgId: 'o-1', type: 'ticket', dedupeKey: 'ticket:t-1:assigned:u-2:evt-1',
    }));
    expect(push.dispatchPushToTokens).toHaveBeenCalledWith(
      [{ token: 'tok', platform: 'ios', provider: 'apns' }],
      expect.objectContaining({ title: 'Ticket assigned to you', body: 'T-2026-0042 \u00b7 Acme' }),
      'ticket',
    );
    // #1105: the notification context closes BEFORE the Redis throttle
    // admission; the device read runs in its own short second context.
    expect(push.order).toEqual(['ctx:enter', 'ctx:exit', 'admit', 'ctx:enter', 'tokens', 'ctx:exit', 'dispatch']);
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('dedupe replay (createNotification -> null): no push, no email', async () => {
    push.createNotification.mockResolvedValueOnce(null);
    await handleTicketEvent(assigned() as never);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to job.id when the event has no eventId (pre-deploy jobs)', async () => {
    await handleTicketEvent({ ...assigned(), eventId: undefined } as never, 'job-77');
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'ticket:t-1:assigned:u-2:job-77' }));
  });

  it('foreign-partner assignee: no row, no push, no email, reported', async () => {
    push.loadUserCandidate.mockResolvedValueOnce({ userId: 'u-2', partnerId: 'p-OTHER', status: 'active', email: 'x@y' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).not.toHaveBeenCalled();
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('assignedEnabled=false: in-app + email, no push', async () => {
    push.loadTicketPushPrefs.mockResolvedValueOnce({ assignedEnabled: false, slaScope: 'owned' });
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
    expect(push.admitPush).toHaveBeenCalledWith([]);
  });

  it('assignee lacking org access is not pushed (row still written)', async () => {
    push.isAuthorisedForTicket.mockResolvedValueOnce(false);
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalled();
    expect(push.admitPush).toHaveBeenCalledWith([]);
  });

  /**
   * REGRESSION (#4281 review): `status !== 'active'` was a TERMINAL gate on the
   * whole collector, so an invited (not-yet-onboarded) technician assigned a
   * ticket silently lost the in-app row AND the assignment email that main sent
   * unconditionally. Account status is a PUSH precondition (a device cannot be
   * registered without a login), never a reason to withhold the inbox row.
   */
  it('invited assignee still gets the in-app row and the email — only the push is gated', async () => {
    push.loadUserCandidate.mockResolvedValueOnce({ userId: 'u-2', partnerId: 'p-1', status: 'invited', email: 'invited@msp.example' });
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION (#4281 review): `tickets.partner_id` is deliberately NULLABLE
   * (see 2026-06-09-a-native-ticketing-core.sql — "old API code may still
   * insert tickets without it during a rolling deploy"), and both emitters
   * propagate the null verbatim. `assertSamePartner(candidate, null)` returns
   * false, which made the whole recipient terminal AND raised a Sentry error
   * framed as a forgery signal. A missing event partner gates the PUSH (already
   * conditional on event.partnerId) — never the row or the email.
   */
  it('legacy ticket with a null event partner: row + email still written, push withheld, nothing reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleTicketEvent({ ...assigned(), partnerId: null } as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * REGRESSION (#4281 review): the up-to-500-recipient fan-out held one pooled
   * Postgres connection in an OPEN transaction across a Redis `multi()` and an
   * N-query device read per recipient (the #1105 class the worker's own comment
   * claims to avoid). The throttle admission is Redis-only and must run with no
   * DB context open; the device read gets its own short, batched context.
   */
  it('the Redis throttle admission runs AFTER the notification context closes (#1105)', async () => {
    await handleTicketEvent(assigned() as never);
    const firstExit = push.order.indexOf('ctx:exit');
    expect(firstExit).toBeGreaterThanOrEqual(0);
    expect(push.order.slice(0, firstExit)).not.toContain('admit');
    expect(push.order.slice(0, firstExit)).not.toContain('tokens');
    expect(push.order.indexOf('admit')).toBeGreaterThan(firstExit);
  });

  it('throttled / quiet-hours / apns-off: row + email, no dispatch', async () => {
    push.admitPush.mockResolvedValueOnce([]);
    await handleTicketEvent(assigned() as never);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
  });
});

describe('sla_breached fan-out (W07)', () => {
  const breach = (assigneeId: string | null) => ({
    type: 'ticket.sla_breached' as const, ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1', actorUserId: null, eventId: 'evt-2',
    payload: { target: 'response' as const, internalNumber: 'T-2026-0042', subject: 'Printer', assigneeId },
  });
  beforeEach(() => {
    resetPushMocks();
    selectMock.mockResolvedValueOnce([TICKET]).mockResolvedValueOnce([{ name: 'Acme' }]);
  });

  it("owner with slaScope 'owned' gets row + push + email; key has no eventId", async () => {
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2', dedupeKey: 'ticket:t-1:sla:response:u-2' }));
    expect(push.dispatchPushToTokens).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'SLA breached (response)' }), 'ticket');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("owner with slaScope 'off' still gets the in-app row and the email — only the push stops (D6)", async () => {
    push.loadTicketPushPrefs.mockResolvedValueOnce({ assignedEnabled: true, slaScope: 'off' });
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2', dedupeKey: 'ticket:t-1:sla:response:u-2' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(push.admitPush).toHaveBeenCalledWith([]);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    // Short-circuit: 'off' must not cost a permission round-trip.
    expect(push.isAuthorisedForTicket).not.toHaveBeenCalled();
  });

  it('owner who cannot access the org keeps the row but is not pushed', async () => {
    push.isAuthorisedForTicket.mockResolvedValueOnce(false);
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledTimes(1);
    expect(push.admitPush).toHaveBeenCalledWith([]);
  });

  it("an unauthorised 'any' subscriber gets NO row at all (asymmetry with the owner is deliberate)", async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-5', partnerId: 'p-1', status: 'active', email: null }], truncated: false });
    push.isAuthorisedForTicket.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await handleTicketEvent(breach('u-2') as never);
    const recipients = push.createNotification.mock.calls.map((c) => c[0].userId);
    expect(recipients).toEqual(['u-2']);
  });

  it("unassigned breach reaches only 'any' subscribers; no email", async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [
      { userId: 'u-5', partnerId: 'p-1', status: 'active', email: null },
      { userId: 'u-6', partnerId: 'p-1', status: 'active', email: null },
    ], truncated: false });
    await handleTicketEvent(breach(null) as never);
    expect(push.createNotification).toHaveBeenCalledTimes(2);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-5', dedupeKey: 'ticket:t-1:sla:response:u-5' }));
    expect(push.dispatchPushToTokens).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("'any' subscriber who is also the owner is notified once", async () => {
    push.loadTicketPushPrefs.mockResolvedValueOnce({ assignedEnabled: true, slaScope: 'any' });
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-2', partnerId: 'p-1', status: 'active', email: 'a@b' }], truncated: false });
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledTimes(1);
  });

  it("'any' subscriber without org access is filtered", async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-5', partnerId: 'p-1', status: 'active', email: null }], truncated: false });
    push.isAuthorisedForTicket.mockResolvedValueOnce(false);
    await handleTicketEvent(breach(null) as never);
    expect(push.createNotification).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION (#4281 review): the owner's SLA email was pushed onto `emails`
   * BEFORE `notify()` ran the dedupe check, so a redelivered BullMQ job
   * suppressed the duplicate row and the duplicate push but re-emailed the
   * owner — contradicting the wave's stated invariant ("a retry re-pushes
   * nothing and re-emails nobody"). The assigned branch already got this right.
   */
  it('replay (createNotification -> null) re-emails nobody and re-pushes nothing', async () => {
    push.createNotification.mockResolvedValueOnce(null);
    await handleTicketEvent(breach('u-2') as never);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
  });

  it('invited owner keeps the in-app row and the SLA email; only the push is gated', async () => {
    push.loadUserCandidate.mockResolvedValueOnce({ userId: 'u-2', partnerId: 'p-1', status: 'invited', email: 'tech@msp.example' });
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
  });

  it('null event partner: the owner still gets the SLA row and email, push withheld, nothing reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleTicketEvent({ ...breach('u-2'), partnerId: null } as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('every dispatch happens after the system context exits', async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-5', partnerId: 'p-1', status: 'active', email: null }], truncated: false });
    await handleTicketEvent(breach('u-2') as never);
    const exitAt = push.order.lastIndexOf('ctx:exit');
    expect(push.order.filter((x) => x === 'dispatch').length).toBe(2);
    expect(push.order.slice(0, exitAt)).not.toContain('dispatch');
  });
});
