/**
 * Customer work approval notifications (#4617 W04 T3), driven through the real
 * worker entry point (`handleTicketEvent`). A sibling of
 * ticketNotifyWorker.test.ts (same precedent as ticketNotifyWorker.leak.test.ts):
 * the main suite fakes `../db/schema` with string columns, while these tests
 * need the real table objects so the fake DB below can answer per table — and
 * so a ticket comment planted in the fixtures is only reachable if the code
 * under test actually reads `ticket_comments`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  rows: new Map<string, unknown[]>(),
  tablesRead: [] as string[],
  sendEmail: vi.fn(async (_p: Record<string, unknown>) => undefined),
  createNotification: vi.fn(async (_i: Record<string, unknown>) => 'n-1' as string | null),
  redisSet: vi.fn(async (..._a: unknown[]) => 'OK' as string | null),
  redisAvailable: true,
  loadUserCandidate: vi.fn(async (id: string) => ({ userId: id, partnerId: 'p-1', status: 'active', email: `${id}@msp.example` })),
}));

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  getRedis: vi.fn(() => (h.redisAvailable ? { set: h.redisSet } : null)),
}));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendEmail: h.sendEmail }) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../services/ticketMailbox/resolveOutboundMailbox', () => ({ resolveOutboundMailbox: vi.fn(async () => null) }));
vi.mock('../services/ticketMailbox/graphReplySender', () => ({ sendThreadedReply: vi.fn(), sendNewMail: vi.fn() }));
vi.mock('../services/userNotifications', () => ({ createNotification: h.createNotification }));
vi.mock('../services/portal/timezone', () => ({ resolveOrgTimezone: vi.fn(async () => 'America/Denver') }));
vi.mock('../services/portalUrl', () => ({ portalBase: () => 'https://msp.example/portal' }));
vi.mock('../services/ticketPush', async (orig) => {
  const actual = await orig<typeof import('../services/ticketPush')>();
  return {
    ...actual,
    loadUserCandidate: h.loadUserCandidate,
    isEligibleTicketRecipient: vi.fn(async (c: { status: string; partnerId: string }, partnerId: string) =>
      c.status === 'active' && c.partnerId === partnerId),
    admitPush: vi.fn(async () => []),
    resolvePushJobs: vi.fn(async () => []),
  };
});

// Table-keyed fake: every select resolves the fixture rows of the table it
// read FROM (filters are not evaluated — fixtures hold exactly one row per
// table), and records which tables were read.
vi.mock('../db', () => {
  const chain = () => {
    let table = '';
    const c: Record<string, unknown> = {};
    c.from = (t: unknown) => { table = getTableName(t as never); h.tablesRead.push(table); return c; };
    for (const m of ['where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(h.rows.get(table) ?? []).then(resolve, reject);
    return c;
  };
  return {
    db: { select: () => chain(), update: () => ({ set: () => ({ where: async () => [] }) }) },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
    runOutsideDbContext: <T>(fn: () => T) => fn(),
  };
});

import { handleTicketEvent } from './ticketNotifyWorker';
import { APPROVAL_NOTIFY_COOLDOWN_SECONDS } from './ticketApprovalNotify';

const REQ = '11111111-1111-4111-8111-111111111111';
const TICKET = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

const SECRETS = ['SECRET-INTERNAL-NOTE', 'SECRET-DESCRIPTION', 'SECRET-TIME-NOTE', 'SECRET-STAFF-MESSAGE', 'Tina Technician'];

function requestRow(over: Record<string, unknown> = {}) {
  return {
    id: REQ, orgId: ORG, ticketId: TICKET, trigger: 'budget', origin: 'auto', status: 'pending', revision: 2,
    enforcement: 'soft', requestedByUserId: 'staff-requester', requestedAt: new Date('2026-12-01T10:00:00Z'),
    expiresAt: new Date('2026-12-04T10:00:00Z'), message: 'SECRET-STAFF-MESSAGE',
    budgetMinutesAtRequest: 600, consumedMinutesAtRequest: 585, budgetAmountAtRequest: '1500.00',
    consumedAmountAtRequest: '1462.50', currencyCode: 'USD', requestedExtensionMinutes: 150,
    requestedExtensionAmount: '375.00', coverageStartsAt: null, coverageEndsAt: null, afterHoursWorkTypeId: null,
    approverEmails: ['approver@customer.example'], notifyEmails: ['requester@customer.example'],
    decidedAt: null, decisionOrigin: null, decidedByPortalUserId: null, decidedByUserId: null, signerName: null,
    signerEmail: null, decisionMethod: null, decisionReference: null, decisionNote: null, decidedRevision: null,
    approvedExtensionMinutes: null, approvedExtensionAmount: null, ipAddress: null, userAgent: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function seed(o: { request?: Record<string, unknown> | null; ticket?: Record<string, unknown>; partnerSettings?: unknown; enableTickets?: boolean | null } = {}) {
  h.rows.clear();
  if (o.request !== null) h.rows.set('ticket_approval_requests', [requestRow(o.request ?? {})]);
  h.rows.set('tickets', [{
    id: TICKET, orgId: ORG, partnerId: 'p-1', internalNumber: 'T-1042', ticketNumber: 'TKT-1', subject: 'Server migration',
    description: 'SECRET-DESCRIPTION', assignedTo: 'tech-1', deletedAt: null, deviceId: null, ...(o.ticket ?? {}),
  }]);
  h.rows.set('organizations', [{ id: ORG, name: 'Customer Co', partnerId: 'p-1' }]);
  h.rows.set('partners', [{ id: 'p-1', name: 'Lantern IT', settings: o.partnerSettings ?? {} }]);
  h.rows.set('portal_branding', o.enableTickets === null || o.enableTickets === undefined ? [] : [{ enableTickets: o.enableTickets }]);
  // Planted content no customer email may ever carry.
  h.rows.set('ticket_comments', [{ id: 'c-1', ticketId: TICKET, content: 'SECRET-INTERNAL-NOTE', isPublic: false, authorName: 'Tina Technician' }]);
  h.rows.set('time_entries', [{ id: 'te-1', ticketId: TICKET, notes: 'SECRET-TIME-NOTE', userId: 'tech-1' }]);
  h.rows.set('users', [{ id: 'tech-1', name: 'Tina Technician', email: 'tina@msp.example' }]);
}

const requested = (over: Record<string, unknown> = {}) => ({
  type: 'ticket.approval_requested' as const, ticketId: TICKET, orgId: ORG, partnerId: 'p-1', actorUserId: null,
  eventId: 'evt-r1', payload: { requestId: REQ, trigger: 'budget' as const, revision: 2, created: true, ...over },
});
const decided = (status: 'approved' | 'denied' | 'expired' | 'cancelled', actorUserId: string | null = null) => ({
  type: 'ticket.approval_decided' as const, ticketId: TICKET, orgId: ORG, partnerId: 'p-1', actorUserId,
  eventId: `evt-d-${status}`, payload: { requestId: REQ, trigger: 'budget' as const, status },
});

const sent = () => h.sendEmail.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string; purpose: string; partnerId?: string });

beforeEach(() => {
  vi.clearAllMocks();
  h.tablesRead.length = 0;
  h.redisAvailable = true;
  h.redisSet.mockResolvedValue('OK');
  h.createNotification.mockResolvedValue('n-1');
});

describe('ticket.approval_requested', () => {
  it('sends approvers and notify recipients DISTINCT templates, one message per address, on the partner lane', async () => {
    seed();
    await handleTicketEvent(requested());
    const mails = sent();
    expect(mails.map((m) => m.to).sort()).toEqual(['approver@customer.example', 'requester@customer.example']);
    const approver = mails.find((m) => m.to === 'approver@customer.example')!;
    const notify = mails.find((m) => m.to === 'requester@customer.example')!;
    expect(approver.subject).toBe('[T-1042] Your approval is needed: Server migration');
    expect(notify.subject).toBe('[T-1042] Approval requested: Server migration');
    expect(approver.html).toContain('Up to 2 h 30 m');
    expect(approver.html).toContain('$375.00');
    expect(approver.html).toContain('Budget 10 h, used 9 h 45 m');
    // The deep link points at the authenticated portal page and carries no token.
    expect(approver.html).toContain('https://msp.example/portal/approvals#11111111-1111-4111-8111-111111111111');
    expect(approver.html).not.toMatch(/token=|[?&]t=/);
    for (const m of mails) {
      expect(m.purpose).toBe('ticket.customer_notification');
      expect(m.partnerId).toBe('p-1');
    }
  });

  it('no customer email ever carries ticket comments, the description, time-entry notes, staff names or the staff message', async () => {
    seed();
    await handleTicketEvent(requested());
    seed({ request: { status: 'approved', decidedAt: new Date() } });
    await handleTicketEvent(decided('approved'));
    const mails = sent();
    expect(mails.length).toBeGreaterThanOrEqual(3);
    for (const m of mails) for (const secret of SECRETS) {
      expect(m.html, `${m.subject} leaked ${secret}`).not.toContain(secret);
      expect(m.subject).not.toContain(secret);
    }
    expect(h.tablesRead).not.toContain('ticket_comments');
    expect(h.tablesRead).not.toContain('time_entries');
  });

  it('a partner template override applies to the approver email', async () => {
    seed({ partnerSettings: { emailTemplates: { ticket_approval_requested_approver: {
      subject: 'Please sign off on {{ticket_number}}', heading: null, buttonLabel: 'Open the portal', html: null,
    } } } });
    await handleTicketEvent(requested());
    const approver = sent().find((m) => m.to === 'approver@customer.example')!;
    expect(approver.subject).toBe('Please sign off on T-1042');
    expect(approver.html).toContain('Open the portal');
    // The notify template is not touched by the approver override.
    expect(sent().find((m) => m.to === 'requester@customer.example')!.subject).toBe('[T-1042] Approval requested: Server migration');
  });

  it('with no approver on file, staff get the in-app notice (once per request) and the requester is still told', async () => {
    seed({ request: { approverEmails: [] } });
    await handleTicketEvent(requested());
    const notices = h.createNotification.mock.calls.map((c) => c[0] as { userId: string; title: string; dedupeKey: string; link: string });
    expect(notices.map((n) => n.userId).sort()).toEqual(['staff-requester', 'tech-1']);
    for (const n of notices) {
      expect(n.title).toBe('No approver on file: T-1042');
      expect(n.dedupeKey).toBe(`ticket-approval:${REQ}:no-approver:${n.userId}`);
      expect(n.link).toBe('/tickets#T-1042');
    }
    expect(sent().map((m) => m.to)).toEqual(['requester@customer.example']);
  });

  it('when the org switched portal ticketing off, no customer email is sent and staff are told to record on behalf', async () => {
    seed({ enableTickets: false });
    await handleTicketEvent(requested());
    expect(h.sendEmail).not.toHaveBeenCalled();
    const notices = h.createNotification.mock.calls.map((c) => c[0] as { title: string; message: string; dedupeKey: string });
    expect(notices).toHaveLength(2);
    expect(notices[0]!.title).toBe('Portal approvals are off: T-1042');
    expect(notices[0]!.message).toMatch(/record the decision on the customer's behalf/);
    expect(notices[0]!.dedupeKey).toMatch(new RegExp(`^ticket-approval:${REQ}:portal-off:`));
  });

  it('a missing branding row is fail-open: emails go out', async () => {
    seed({ enableTickets: null });
    await handleTicketEvent(requested());
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a request not yet visible (uncommitted) throws so BullMQ retries, and sends nothing', async () => {
    seed({ request: null });
    await expect(handleTicketEvent(requested())).rejects.toThrow(/likely uncommitted/);
    seed({ request: { revision: 1 } });
    await expect(handleTicketEvent(requested({ revision: 2 }))).rejects.toThrow(/likely uncommitted/);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('a superseded revision or a request no longer pending sends nothing', async () => {
    seed({ request: { revision: 3 } });
    await handleTicketEvent(requested({ revision: 2 }));
    seed({ request: { status: 'cancelled' } });
    await handleTicketEvent(requested());
    seed({ ticket: { deletedAt: new Date() } });
    await handleTicketEvent(requested());
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it(`throttles re-notification per request: one claim per ${APPROVAL_NOTIFY_COOLDOWN_SECONDS}s window`, async () => {
    expect(APPROVAL_NOTIFY_COOLDOWN_SECONDS).toBe(15 * 60);
    seed();
    await handleTicketEvent(requested());
    expect(h.redisSet).toHaveBeenCalledWith(`ticket-approval-notify:${REQ}`, 'evt-r1', 'EX', 900, 'NX');
    expect(h.sendEmail).toHaveBeenCalledTimes(2);

    // A burst of held entries bumps the revision; inside the window the claim fails.
    h.redisSet.mockResolvedValue(null);
    seed({ request: { revision: 3 } });
    await handleTicketEvent({ ...requested({ revision: 3, created: false }), eventId: 'evt-r2' });
    seed({ request: { revision: 4 } });
    await handleTicketEvent({ ...requested({ revision: 4, created: false }), eventId: 'evt-r3' });
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a throttled event still writes the staff notice (in-app is not throttled; it dedupes per request)', async () => {
    h.redisSet.mockResolvedValue(null);
    seed({ request: { approverEmails: [] } });
    await handleTicketEvent(requested());
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.createNotification).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN when Redis is unavailable or errors: the approval email is sent', async () => {
    h.redisAvailable = false;
    seed();
    await handleTicketEvent(requested());
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    h.redisAvailable = true;
    h.redisSet.mockRejectedValue(new Error('redis down'));
    await handleTicketEvent({ ...requested(), eventId: 'evt-r9' });
    expect(h.sendEmail).toHaveBeenCalledTimes(4);
  });

  it('one recipient failing does not stop the others or fail the job', async () => {
    seed();
    h.sendEmail.mockRejectedValueOnce(new Error('bounce'));
    await expect(handleTicketEvent(requested())).resolves.toBeUndefined();
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('an after-hours request states the work in words, with no budget figures', async () => {
    seed({ request: {
      trigger: 'after_hours', requestedExtensionMinutes: null, requestedExtensionAmount: null,
      budgetMinutesAtRequest: null, consumedMinutesAtRequest: null, budgetAmountAtRequest: null, consumedAmountAtRequest: null,
      coverageStartsAt: new Date('2026-12-05T01:00:00Z'), coverageEndsAt: new Date('2026-12-05T05:00:00Z'),
    } });
    await handleTicketEvent({ ...requested(), payload: { ...requested().payload, trigger: 'after_hours' } });
    const approver = sent().find((m) => m.to === 'approver@customer.example')!;
    expect(approver.html).toContain('After-hours work');
    expect(approver.html).not.toContain('Budget');
  });
});

describe('ticket.approval_decided', () => {
  it('notifies the ticket assignee and the requesting user in-app, and confirms to the customer recipients', async () => {
    seed({ request: { status: 'approved', decidedAt: new Date() } });
    await handleTicketEvent(decided('approved'));
    const notices = h.createNotification.mock.calls.map((c) => c[0] as { userId: string; title: string; dedupeKey: string; orgId: string });
    expect(notices.map((n) => n.userId).sort()).toEqual(['staff-requester', 'tech-1']);
    expect(notices[0]!.title).toBe('Customer approved more work: T-1042');
    expect(notices[0]!.orgId).toBe(ORG);
    expect(notices[0]!.dedupeKey).toBe(`ticket-approval:${REQ}:decided:approved:${notices[0]!.userId}`);
    const mails = sent();
    expect(mails.map((m) => m.to).sort()).toEqual(['approver@customer.example', 'requester@customer.example']);
    expect(mails[0]!.subject).toBe('[T-1042] Work approval approved: Server migration');
  });

  it('does not notify the staff member who recorded the decision themselves', async () => {
    seed({ request: { status: 'denied', decidedAt: new Date() } });
    await handleTicketEvent(decided('denied', 'tech-1'));
    expect(h.createNotification.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['staff-requester']);
  });

  it.each(['expired', 'cancelled'] as const)('a %s request notifies staff but sends the customer nothing', async (status) => {
    seed({ request: { status } });
    await handleTicketEvent(decided(status));
    expect(h.createNotification).toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('a decision whose row still reads pending (rolled back or uncommitted) sends no email and retries', async () => {
    seed({ request: { status: 'pending' } });
    await expect(handleTicketEvent(decided('approved'))).rejects.toThrow(/likely uncommitted/);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('a decided event that no longer matches the stored status, or whose request is gone, sends nothing', async () => {
    seed({ request: { status: 'denied' } });
    await handleTicketEvent(decided('approved'));
    seed({ request: null });
    await handleTicketEvent(decided('approved'));
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('the customer confirmation is sent at most once per request and status', async () => {
    seed({ request: { status: 'approved', decidedAt: new Date() } });
    await handleTicketEvent(decided('approved'));
    expect(h.redisSet).toHaveBeenCalledWith(`ticket-approval-notify:${REQ}:decided:approved`, 'evt-d-approved', 'EX', 7 * 24 * 3600, 'NX');
    h.redisSet.mockResolvedValue(null);
    await handleTicketEvent(decided('approved'));
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
  });
});
