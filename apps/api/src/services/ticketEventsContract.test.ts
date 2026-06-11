/**
 * Producer→consumer contract test for the ticket-events seam.
 *
 * Strategy:
 * 1. Run the real ticketService functions (with mocked DB / deps).
 * 2. Capture the TicketEvent objects passed to the mocked emitTicketEvent.
 * 3. Feed each captured event through the real handleTicketEvent (with mocked
 *    DB / email), asserting the expected side-effects.
 *
 * This pins payload field names across the seam: a rename on either side
 * causes a type or runtime failure here.
 *
 * The shared `db` mock uses a call-queue so service calls and worker calls
 * can be sequenced without per-test mock re-wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── hoisted mocks ────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  // A queue of values to return from db.select().from().where().limit() calls.
  const selectQueue: unknown[][] = [];
  const insertReturningQueue: unknown[][] = [];
  const updateReturningQueue: unknown[][] = [];
  const insertValuesMock = vi.fn();
  const sendEmailMock = vi.fn().mockResolvedValue(undefined);
  const getEmailServiceMock = vi.fn();
  const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());
  const emitCaptured: unknown[] = [];
  return {
    selectQueue,
    insertReturningQueue,
    updateReturningQueue,
    insertValuesMock,
    sendEmailMock,
    getEmailServiceMock,
    withSystemDbAccessContextMock,
    emitCaptured
  };
});

// ── module mocks ─────────────────────────────────────────────────────────────

vi.mock('./ticketEvents', () => ({
  emitTicketEvent: vi.fn(async (event: unknown) => { hoisted.emitCaptured.push(event); })
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./ticketNumbers', () => ({ allocateInternalTicketNumber: vi.fn().mockResolvedValue('T-2026-C001') }));

vi.mock('../db', () => ({
  withSystemDbAccessContext: hoisted.withSystemDbAccessContextMock,
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const next = hoisted.selectQueue.shift();
            return Promise.resolve(next ?? []);
          })
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        hoisted.insertValuesMock(v);
        return {
          returning: vi.fn(() => {
            const next = hoisted.insertReturningQueue.shift();
            return Promise.resolve(next ?? []);
          }),
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => {
              const next = hoisted.insertReturningQueue.shift();
              return Promise.resolve(next ?? []);
            })
          }))
        };
      })
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => {
            const next = hoisted.updateReturningQueue.shift();
            return Promise.resolve(next ?? []);
          })
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          const next = hoisted.insertReturningQueue.shift();
          return Promise.resolve(next ?? []);
        })
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', status: 'status', assignedTo: 'assignedTo', firstResponseAt: 'firstResponseAt' },
  ticketComments: {},
  ticketAlertLinks: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
  alerts: { id: 'id', orgId: 'orgId' },
  users: { id: 'id', email: 'email', partnerId: 'partnerId' },
  ticketCategories: { id: 'id', partnerId: 'partnerId' },
  devices: { id: 'id', orgId: 'orgId' },
  userNotifications: {},
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/email', () => ({ getEmailService: hoisted.getEmailServiceMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/emailLayout', () => ({
  escapeHtml: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}));

// ── real implementations ─────────────────────────────────────────────────────

import { createTicket, addTicketComment, changeTicketStatus, updateTicketFields } from './ticketService';
import { handleTicketEvent } from '../jobs/ticketNotifyWorker';
import type { TicketEvent } from './ticketEvents';

const actor = { userId: 'u-actor', name: 'Actor User' };

describe('ticket-events producer→consumer contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear queues
    hoisted.selectQueue.length = 0;
    hoisted.insertReturningQueue.length = 0;
    hoisted.updateReturningQueue.length = 0;
    hoisted.emitCaptured.length = 0;
    hoisted.withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
    hoisted.getEmailServiceMock.mockReturnValue({ sendEmail: hoisted.sendEmailMock });
    hoisted.sendEmailMock.mockResolvedValue(undefined);
  });

  // ── createTicket with assignee → ticket.created ──────────────────────────

  it('createTicket with assignee: emitted event feeds handleTicketEvent → in-app insert + email', async () => {
    // Service selects: org lookup, then assignee lookup (users table)
    hoisted.selectQueue.push([{ id: 'o-1', partnerId: 'p-1' }]);
    hoisted.selectQueue.push([{ id: 'u-assignee', partnerId: 'p-1' }]);
    // Service insert: ticket insert returning
    hoisted.insertReturningQueue.push([{ id: 't-c1', orgId: 'o-1', internalNumber: 'T-2026-C001', status: 'open' }]);

    await createTicket({ orgId: 'o-1', subject: 'Contract test', source: 'manual', assigneeId: 'u-assignee' }, actor);

    // Exactly one event was emitted
    expect(hoisted.emitCaptured).toHaveLength(1);
    const event = hoisted.emitCaptured[0] as TicketEvent;
    expect(event.type).toBe('ticket.created');

    // Worker selects: ticket lookup, then assignee user lookup
    hoisted.selectQueue.push(
      [{ id: 't-c1', orgId: 'o-1', internalNumber: 'T-2026-C001', subject: 'Contract test', submitterEmail: null }],
      [{ id: 'u-assignee', email: 'tech@msp.example' }]
    );
    // Worker insert: userNotifications insert
    hoisted.insertReturningQueue.push([]);

    hoisted.insertValuesMock.mockClear();

    await handleTicketEvent(event);

    expect(hoisted.insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-assignee',
      type: 'ticket'
    }));
    expect(hoisted.sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'tech@msp.example',
      subject: expect.stringContaining('T-2026-C001')
    }));
  });

  // ── addTicketComment (public) → ticket.commented ─────────────────────────

  it('addTicketComment (public): emitted event feeds handleTicketEvent → requester email', async () => {
    // Service: ticket lookup for addTicketComment
    hoisted.selectQueue.push([{
      id: 't-c2', orgId: 'o-1', partnerId: 'p-1', status: 'open', firstResponseAt: null
    }]);
    // Service: comment insert returning
    hoisted.insertReturningQueue.push([{ id: 'comment-1', isPublic: true }]);
    // Service: update firstResponseAt returning
    hoisted.updateReturningQueue.push([{ id: 't-c2' }]);

    await addTicketComment('t-c2', { content: 'We are looking into this.', isPublic: true }, actor);

    expect(hoisted.emitCaptured).toHaveLength(1);
    const event = hoisted.emitCaptured[0] as TicketEvent;
    expect(event.type).toBe('ticket.commented');

    // Worker: ticket lookup — this ticket has submitterEmail
    hoisted.selectQueue.push([{
      id: 't-c2', orgId: 'o-1', internalNumber: 'T-2026-C001', subject: 'Contract test',
      submitterEmail: 'user@acme.example'
    }]);

    await handleTicketEvent(event);

    expect(hoisted.sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@acme.example',
      subject: expect.stringContaining('New reply')
    }));
  });

  // ── changeTicketStatus (resolve) → ticket.status_changed ─────────────────

  it('changeTicketStatus to resolved: emitted event feeds handleTicketEvent → requester email with resolution note', async () => {
    // Service: ticket lookup for changeTicketStatus
    hoisted.selectQueue.push([{
      id: 't-c3', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null
    }]);
    // Service: update returning
    hoisted.updateReturningQueue.push([{ id: 't-c3', status: 'resolved' }]);
    // Service: comment insert returning
    hoisted.insertReturningQueue.push([{ id: 'feed-1' }]);

    await changeTicketStatus('t-c3', 'resolved', { resolutionNote: 'Fixed the printer.' }, actor);

    expect(hoisted.emitCaptured).toHaveLength(1);
    const event = hoisted.emitCaptured[0] as TicketEvent;
    expect(event.type).toBe('ticket.status_changed');

    // Verify payload field names via narrowed access — this is the seam assertion
    if (event.type === 'ticket.status_changed') {
      expect(event.payload.to).toBe('resolved');
      expect(event.payload.from).toBe('open');
      expect(event.payload.resolutionNote).toBe('Fixed the printer.');
    }

    // Worker: ticket lookup
    hoisted.selectQueue.push([{
      id: 't-c3', orgId: 'o-1', internalNumber: 'T-2026-C001', subject: 'Contract test',
      submitterEmail: 'user@acme.example'
    }]);

    await handleTicketEvent(event);

    expect(hoisted.sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@acme.example',
      subject: expect.stringContaining('Resolved')
    }));
    const emailCall = hoisted.sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(emailCall.html).toContain('Fixed the printer.');
  });

  // ── updateTicketFields → ticket.updated ───────────────────────────────────

  it('updateTicketFields: emitted ticket.updated event feeds handleTicketEvent → explicit no-op (no insert, no email)', async () => {
    // Service selects: ticket lookup
    hoisted.selectQueue.push([{
      id: 't-c4', orgId: 'o-1', partnerId: 'p-1', status: 'open',
      subject: 'Old subject', priority: 'normal', description: null,
      categoryId: null, dueDate: null, deviceId: null, tags: []
    }]);
    // Service update: returning
    hoisted.updateReturningQueue.push([{ id: 't-c4', subject: 'New subject', priority: 'high' }]);
    // Service insert: system feed entry returning
    hoisted.insertReturningQueue.push([{ id: 'feed-2' }]);

    await updateTicketFields('t-c4', { subject: 'New subject', priority: 'high' }, actor);

    expect(hoisted.emitCaptured).toHaveLength(1);
    const event = hoisted.emitCaptured[0] as TicketEvent;
    expect(event.type).toBe('ticket.updated');

    // Verify payload field names via narrowed access — this is the seam assertion
    if (event.type === 'ticket.updated') {
      expect(event.payload.changed).toEqual(['subject', 'priority']);
    }

    hoisted.insertValuesMock.mockClear();

    // Worker: ticket.updated is a deliberate no-op — must not throw, insert, or email
    await expect(handleTicketEvent(event)).resolves.toBeUndefined();
    expect(hoisted.insertValuesMock).not.toHaveBeenCalled();
    expect(hoisted.sendEmailMock).not.toHaveBeenCalled();
  });
});
