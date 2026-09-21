/**
 * Internal-note leak regression for the outbound composer (spec §6/§9).
 *
 * Task 8 of docs/superpowers/plans/ticketing/2026-06-13-ticketing-phase4-outbound-backend.md
 *
 * Guarantee: a private ticket_comment (is_public=false) MUST NEVER:
 *   (a) directly trigger an outbound email (even if the worker somehow sees isPublic:false
 *       on the event payload), and
 *   (b) have its `content` appear in any outbound email body/subject produced by the
 *       email-sending branches (public comment, resolved, autoresponse) — even if a
 *       future refactor starts threading comment content into the body.
 *
 * The load-bearing design: PRIVATE_COMMENT_ROW is seeded as the value the mocked
 * db.select() returns for every call that resolves to ticket_comments. Today's
 * composer never reads that content into the body — so both tests pass. A future
 * regression that starts reading comment content would cause test (b) to fail loudly,
 * because the secret IS reachable through the mocked comment-lookup path.
 *
 * Mocked-DB test — same harness shape as ticketNotifyWorker.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import that resolves the mocked modules)
// ---------------------------------------------------------------------------
const { selectMock, selectFromTablesMock, insertValuesMock, updateSetMock, sendEmailMock, getEmailServiceMock, withSystemDbAccessContextMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue([]);
  const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());
  return {
    insertValuesMock,
    selectMock: vi.fn(),
    // Records the `__t` marker of every table passed to db.select().from(table),
    // so we can assert the composer NEVER queries ticket_comments — comment content
    // is structurally unreachable because it is never loaded.
    selectFromTablesMock: vi.fn(),
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
// collectRequesterEmail resolves the partner's connected M365 mailbox before
// composing. The real resolver issues a db.select().from().innerJoin() chain the
// simplified db mock below doesn't implement — and it only touches mailbox
// connection/ownership tables (never ticket_comments), so mocking it keeps the
// leak invariant meaningful. Same pattern as ticketNotifyWorker.test.ts.
vi.mock('../services/ticketMailbox/resolveOutboundMailbox', () => ({
  resolveOutboundMailbox: vi.fn(async () => null)
}));
vi.mock('../services/inboundEmail/commentNotificationPortalHref', () => ({
  resolveCommentNotificationPortalHref: vi.fn(async () => ({
    href: 'https://example.test/portal/tickets/t-1',
    hasPortalUser: false,
  })),
}));
// outboundThreading.ts reads TICKETS_INBOUND_DOMAIN via getConfig(). Specifier
// from jobs/ is '../config/validate' — the same as ticketNotifyWorker.test.ts.
vi.mock('../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  db: {
    select: vi.fn(() => ({
      from: vi.fn((tbl: unknown) => {
        selectFromTablesMock((tbl as { __t?: string })?.__t ?? 'unknown');
        return {
          where: vi.fn(() => ({ limit: vi.fn(() => selectMock()) }))
        };
      })
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        insertValuesMock(v);
        return { returning: vi.fn(() => Promise.resolve([])) };
      })
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => {
        updateSetMock(v);
        return { where: vi.fn(() => Promise.resolve([])) };
      })
    }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { __t: 'tickets', id: 'id' },
  partners: { __t: 'partners', id: 'id', slug: 'slug', name: 'name', settings: 'settings' },
  organizations: { __t: 'organizations', id: 'id', name: 'name' },
  userNotifications: { __t: 'user_notifications' },
  users: { __t: 'users', id: 'id' },
  // Present so a regression that DOES query it would be caught by the table assertion.
  ticketComments: { __t: 'ticket_comments', id: 'id', ticketId: 'ticketId', content: 'content' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));

import { handleTicketEvent } from './ticketNotifyWorker';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// The sentinel secret. Must NOT appear in any outbound email body or subject.
const SECRET = 'INTERNAL: customer is a flight risk, do not disclose';

// A real private comment row for ticket 't-1' whose CONTENT is the SECRET. The
// mocked db returns this for a ticket_comments lookup so that if any branch ever
// threads comment content into the body, the secret would leak — and fail.
const PRIVATE_COMMENT_ROW = {
  id: 'c-secret',
  ticketId: 't-1',
  isPublic: false,
  authorType: 'internal',
  commentType: 'note',
  content: SECRET
};

// A ticket row with submitterEmail set (so public branches attempt a send) and a
// subject that does NOT contain SECRET (so a pass on "subject clean" is meaningful
// and proves body cleanliness independently of the subject assertion).
const TICKET_ROW = {
  id: 't-1',
  orgId: 'o-1',
  partnerId: 'p-1',
  internalNumber: 'T-2026-0001',
  subject: 'Printer is down',
  submitterEmail: 'jane@customer.example',
  emailThreadKey: null,
  // #3828 wave-6-3 task 2 review fix: the resolved status_changed branch now
  // guards on ticket.status === 'resolved' (freshness check) — this shared
  // fixture is committed/fresh in every branch that exercises it.
  status: 'resolved'
};

const PARTNER_ROW = { slug: 'acme', settings: {} };

// ---------------------------------------------------------------------------
// Setup — configures mocks per test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailMock.mockReset().mockResolvedValue(undefined);
  selectMock.mockReset();
  selectFromTablesMock.mockReset();
  updateSetMock.mockReset();
  withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });

  // Default select sequence for branches that need ticket + partner rows.
  // The db.select mock chains are consumed in call order (the worker calls
  // getTicket first, then partner lookup for threaded/autoresponse branches).
  // PRIVATE_COMMENT_ROW is seeded for any additional select call (e.g. a
  // regression that starts querying ticket_comments before composing the body).
  selectMock
    .mockResolvedValueOnce([TICKET_ROW])       // 1st call: getTicket
    .mockResolvedValueOnce([PARTNER_ROW])      // 2nd call: partner slug+settings
    .mockResolvedValue([PRIVATE_COMMENT_ROW]); // subsequent: comment lookup → secret reachable
});

// ---------------------------------------------------------------------------
// Test 1: Private comment MUST emit no email at all
// ---------------------------------------------------------------------------

describe('outbound composer never leaks an internal note (spec §6/§9)', () => {
  it('does NOT email the requester for a private (is_public=false) comment', async () => {
    // Reset to just the ticket row — no partner lookup happens for a private comment.
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValue([PRIVATE_COMMENT_ROW]);

    await handleTicketEvent({
      type: 'ticket.commented',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { commentId: 'c-secret', isPublic: false }
    } as never);

    // The worker's guard is `isPublic && !inbound` — a private comment must emit nothing.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Every email-producing branch must NEVER include the secret in output
  // ---------------------------------------------------------------------------

  it('the composer NEVER queries ticket_comments across any email-producing branch (content is structurally unreachable)', async () => {
    // Meaningful invariant: the composer is TEMPLATE-ONLY — it never loads a comment
    // row, so comment content can never reach an outbound body/subject regardless of
    // what the body template renders. We prove this by asserting that across ALL
    // email-producing branches (public comment, resolved, autoresponse) the worker
    // issues ZERO db.select().from(ticketComments). (The earlier "assert SECRET not in
    // body" check was vacuous — the composer never read the seeded comment, so the
    // assertion was trivially true. Asserting the table is never queried is the
    // refactor-robust version: a future regression that starts loading comment content
    // would query ticket_comments and fail here.)

    // Branch 1: public technician comment (threaded reply)
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValueOnce([PARTNER_ROW])
      .mockResolvedValue([PRIVATE_COMMENT_ROW]);

    await handleTicketEvent({
      type: 'ticket.commented',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { commentId: 'c-secret', isPublic: true }
    } as never);

    // Branch 2: ticket resolved (layout; partner/org for templates, never comments)
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValue([PRIVATE_COMMENT_ROW]);

    await handleTicketEvent({
      type: 'ticket.status_changed',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { from: 'open', to: 'resolved', resolutionNote: null }
    } as never);

    // Branch 3: autoresponse (ticket row + partner row)
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValueOnce([PARTNER_ROW])
      .mockResolvedValue([PRIVATE_COMMENT_ROW]);

    await handleTicketEvent({
      type: 'ticket.autoresponse',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: null,
      payload: { to: 'jane@customer.example', internalNumber: 'T-2026-0001', subject: 'Printer is down' }
    } as never);

    // At least the three public branches sent email — confirms the test exercised the
    // composer (not a no-op: if no emails were sent the table assertion would be
    // vacuously satisfiable too).
    expect(sendEmailMock).toHaveBeenCalled();

    // The composer must NEVER have loaded a ticket_comments row in any branch.
    const queriedTables = selectFromTablesMock.mock.calls.map((c) => c[0]);
    expect(queriedTables).not.toContain('ticket_comments');
    // Sanity: it DID query the tables it legitimately needs (proves the spy works).
    expect(queriedTables).toContain('tickets');

    // Defense-in-depth: even if some future template DID render comment content,
    // the seeded SECRET must not appear — but the real guarantee is the table
    // assertion above (the secret is unreachable because it is never loaded).
    for (const call of sendEmailMock.mock.calls) {
      const args = call[0] as { html?: string; subject?: string; to?: string };
      if (args.html !== undefined) {
        expect(args.html).not.toContain(SECRET);
      }
      if (args.subject !== undefined) {
        expect(args.subject).not.toContain(SECRET);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// fullMessageReply ON — the actual comment text is emailed to the requester,
// but ONLY for a live, PUBLIC comment on the EmailService (non-Graph) path.
// ---------------------------------------------------------------------------
describe('fullMessageReply: public comment body reaches the requester email; private/deleted never do', () => {
  const PUBLIC_TEXT = 'Hi Jane, your printer driver has been reinstalled remotely. Please test.';
  const PARTNER_ROW_FMR = { slug: 'acme', name: 'Acme', settings: { ticketing: { inbound: { fullMessageReply: true } } } };
  const ORG_ROW = { name: 'Acme Org' };
  const publicComment = { id: 'c-pub', ticketId: 't-1', isPublic: true, deletedAt: null, content: PUBLIC_TEXT };

  function commentedEvent() {
    return {
      type: 'ticket.commented',
      ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1', actorUserId: 'u-1',
      payload: { commentId: 'c-pub', isPublic: true },
    } as never;
  }

  it('appends a live public comment body to the outbound email', async () => {
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])        // getTicket
      .mockResolvedValueOnce([PARTNER_ROW_FMR])   // compose: partner (fullMessageReply on)
      .mockResolvedValueOnce([ORG_ROW])           // compose: getOrgName
      .mockResolvedValue([publicComment]);        // comment lookup

    await handleTicketEvent(commentedEvent());

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const html = (sendEmailMock.mock.calls[0]![0] as { html: string }).html;
    expect(html).toContain('printer driver has been reinstalled');
    // The reply body must sit INSIDE the document (before </body>), not after
    // </html> where mail clients may strip it.
    const closeBody = html.toLowerCase().lastIndexOf('</body>');
    expect(closeBody).toBeGreaterThan(-1);
    expect(html.indexOf('printer driver has been reinstalled')).toBeLessThan(closeBody);
  });

  it('does NOT append a private comment even with fullMessageReply on (isPublic guard)', async () => {
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValueOnce([PARTNER_ROW_FMR])
      .mockResolvedValueOnce([ORG_ROW])
      .mockResolvedValue([{ ...publicComment, isPublic: false, content: SECRET }]);

    await handleTicketEvent(commentedEvent());

    const html = (sendEmailMock.mock.calls[0]![0] as { html: string }).html;
    expect(html).not.toContain(SECRET);
  });

  it('does NOT append a soft-deleted comment (deletedAt guard)', async () => {
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValueOnce([PARTNER_ROW_FMR])
      .mockResolvedValueOnce([ORG_ROW])
      .mockResolvedValue([{ ...publicComment, deletedAt: new Date(), content: SECRET }]);

    await handleTicketEvent(commentedEvent());

    const html = (sendEmailMock.mock.calls[0]![0] as { html: string }).html;
    expect(html).not.toContain(SECRET);
  });

  it('throws to retry when the comment row is not yet visible (pre-commit)', async () => {
    selectMock.mockReset();
    selectMock
      .mockResolvedValueOnce([TICKET_ROW])
      .mockResolvedValueOnce([PARTNER_ROW_FMR])
      .mockResolvedValueOnce([ORG_ROW])
      .mockResolvedValue([]); // comment not committed yet

    await expect(handleTicketEvent(commentedEvent())).rejects.toThrow(/Comment not found/);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
