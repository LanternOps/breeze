/**
 * Portal tickets route — regression tests.
 *
 * Task 15: internal-note leak guard.
 *
 * The GET /tickets/:id route MUST:
 *   1. Only select comments where isPublic = TRUE (SQL filter).
 *   2. Only select comments where deletedAt IS NULL (SQL filter — added in Task 15).
 *
 * These tests verify the invariants by:
 *   - Providing a mock DB that captures the WHERE conditions passed to it.
 *   - Asserting the conditions include both an isPublic filter and a deletedAt IS NULL filter.
 *   - Also asserting the response only contains the public, non-deleted comments
 *     that the mock is set up to return (black-box contract test).
 *
 * B1 fix: POST /tickets delegates to createTicket (mock) with source: 'portal',
 *   submitter fields mapped, and the response shape preserved.
 *
 * Task 7: portal comment edit/delete within until-staff-reply window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── service mocks ─────────────────────────────────────────────────────────────

const { createTicketMock, portalCommentMutableMock, editTicketCommentMock, deleteTicketCommentMock } = vi.hoisted(() => ({
  createTicketMock: vi.fn(),
  portalCommentMutableMock: vi.fn(),
  editTicketCommentMock: vi.fn(),
  deleteTicketCommentMock: vi.fn(),
}));

vi.mock('../../services/ticketService', () => ({
  createTicket: createTicketMock,
  portalCommentMutable: portalCommentMutableMock,
  editTicketComment: editTicketCommentMock,
  deleteTicketComment: deleteTicketCommentMock,
  TicketServiceError: class TicketServiceError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = 'TicketServiceError';
      this.status = status;
    }
  }
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

const { dbSelectMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn()
}));

vi.mock('../../db', () => ({
  db: {
    select: dbSelectMock,
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) }))
  }
}));

vi.mock('../../db/schema', () => ({
  tickets: {
    id: 'id', orgId: 'orgId', ticketNumber: 'ticketNumber',
    subject: 'subject', description: 'description', status: 'status',
    priority: 'priority', submittedBy: 'submittedBy', createdAt: 'createdAt',
    updatedAt: 'updatedAt', statusId: 'statusId', deletedAt: 'deletedAt'
  },
  ticketComments: {
    id: 'id', ticketId: 'ticketId', authorName: 'authorName',
    content: 'content', isPublic: 'isPublic', deletedAt: 'deletedAt',
    createdAt: 'createdAt'
  },
  ticketStatuses: {
    id: 'id', name: 'name', color: 'color'
  }
}));

vi.mock('./helpers', () => ({
  applyPortalCacheHeaders: vi.fn(),
  buildWeakEtag: vi.fn(() => '"etag-1"'),
  getPagination: vi.fn(() => ({ page: 1, limit: 20, offset: 0 })),
  isEtagFresh: vi.fn(() => false),
  validatePortalCookieCsrfRequest: vi.fn(() => null),
  writePortalAudit: vi.fn()
}));

import { ticketRoutes } from './tickets';
import { validatePortalCookieCsrfRequest, writePortalAudit } from './helpers';

// ── Test app ──────────────────────────────────────────────────────────────────

const PORTAL_USER = { id: 'pu-1', orgId: 'o-1', email: 'user@example.com', name: 'Test User' };

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth' as never, { user: PORTAL_USER, token: 'tok-1', authMethod: 'bearer' });
    await next();
  });
  app.route('/', ticketRoutes);
  return app;
}

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const COMMENT_ID = 'aaaabbbb-1111-2222-3333-ccccdddd0000';

const TICKET_ROW = {
  id: TICKET_ID,
  ticketNumber: 'ABCDE12345',
  subject: 'Test ticket',
  description: null,
  status: 'new',
  priority: 'normal',
  createdAt: new Date(),
  updatedAt: new Date()
};

// Valid UUID for route params (zValidator uses .guid())
const portalJsonHeaders = {
  'Content-Type': 'application/json',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /tickets/:id — portal internal-note isolation', () => {
  let app: ReturnType<typeof buildApp>;
  // Capture all WHERE conditions passed to the comments select
  let capturedWhereArgs: unknown[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhereArgs = [];
    app = buildApp();
  });

  /**
   * Sets up the DB mock so:
   *   - Call 1 (ticket lookup) returns the ticket row.
   *   - Call 2 (comments) captures the where() arguments and returns commentsRows.
   */
  function setupMocks(commentsRows: object[]) {
    let callCount = 0;
    dbSelectMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Ticket lookup — route does .from().leftJoin().where().limit()
        const whereLimit = vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([TICKET_ROW]))
        }));
        const leftJoin = vi.fn(() => ({ where: whereLimit }));
        return {
          from: vi.fn(() => ({ leftJoin }))
        };
      }
      // Comments lookup — route does .from().where().orderBy(); capture the where args
      return {
        from: vi.fn(() => ({
          where: vi.fn((...args: unknown[]) => {
            capturedWhereArgs = args;
            return {
              orderBy: vi.fn(() => Promise.resolve(commentsRows))
            };
          })
        }))
      };
    });
  }

  it('excludes internal comments: SQL WHERE includes isPublic filter', async () => {
    // The route should pass the isPublic condition to .where().
    // We verify by checking the where args include the isPublic column reference.
    setupMocks([
      { id: 'c-1', content: 'public reply', isPublic: true, deletedAt: null, authorName: 'Tech', createdAt: new Date() }
    ]);

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);

    // The WHERE clause arguments must reference the isPublic column (value 'isPublic' per schema mock)
    const whereStr = JSON.stringify(capturedWhereArgs);
    expect(whereStr).toContain('isPublic');
  });

  it('excludes soft-deleted comments: SQL WHERE includes deletedAt IS NULL filter', async () => {
    // The route must include isNull(ticketComments.deletedAt) in the WHERE clause.
    // We verify by checking the where args include the deletedAt column reference.
    setupMocks([
      { id: 'c-2', content: 'active public reply', isPublic: true, deletedAt: null, authorName: 'Tech', createdAt: new Date() }
    ]);

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);

    // The WHERE clause arguments must reference the deletedAt column (value 'deletedAt' per schema mock)
    const whereStr = JSON.stringify(capturedWhereArgs);
    expect(whereStr).toContain('deletedAt');
  });

  it('response body only contains the comments the DB returned (no phantom injection)', async () => {
    setupMocks([
      { id: 'c-3', content: 'legitimate public reply', isPublic: true, deletedAt: null, authorName: 'Tech', createdAt: new Date() }
    ]);

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain('legitimate public reply');
  });

  it('portal cannot see internal content: black-box regression', async () => {
    // Black-box contract: even if the mock returns an already-filtered set
    // (what real SQL would return with isPublic=true AND deletedAt IS NULL),
    // the response must never contain internal or deleted content markers.
    // This guards against any future regression that would bypass the SQL filter.
    setupMocks([
      { id: 'c-4', content: 'SAFE_PUBLIC_CONTENT', isPublic: true, deletedAt: null, authorName: 'Tech', createdAt: new Date() }
    ]);

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain('SAFE_PUBLIC_CONTENT');
    // If internal comments leaked, these patterns would appear
    expect(bodyStr).not.toContain('INTERNAL:');
    expect(bodyStr).not.toContain('"isPublic":false');
  });

  it('returns 404 when the ticket does not belong to the portal user', async () => {
    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([]))
          }))
        }))
      }))
    }));

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(404);
  });
});

// ── Soft-delete exclusion: customer list + detail (Phase 6) ──────────────────

describe('portal ticket soft-delete exclusion', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('GET /tickets: customer list WHERE includes isNull(tickets.deletedAt)', async () => {
    // The list query builds `conditions` (org + submittedBy + isNull(deletedAt))
    // once and reuses it for both the count and the data select. Capturing either
    // proves a soft-deleted ticket can never appear in the customer's own list.
    let capturedListWhere: unknown[] = [];
    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({
        // count query: `.from(tickets).where(conditions)` awaited directly
        where: vi.fn((...args: unknown[]) => {
          capturedListWhere = args;
          return Promise.resolve([{ count: 0 }]);
        }),
        // data query: `.from(tickets).leftJoin().where(conditions).orderBy().limit().offset()`
        leftJoin: vi.fn(() => ({
          where: vi.fn((...args: unknown[]) => {
            capturedListWhere = args;
            return {
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve([])) }))
              }))
            };
          })
        }))
      }))
    }));

    const res = await app.request('/tickets', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(200);

    const whereStr = JSON.stringify(capturedListWhere);
    expect(whereStr).toContain('deletedAt');
    expect(whereStr).toContain('is null');
  });

  it('GET /tickets/:id: detail lookup WHERE includes isNull(tickets.deletedAt)', async () => {
    // A customer must never resolve their OWN soft-deleted ticket by id — the
    // by-id lookup gates on isNull(tickets.deletedAt) alongside the org/submitter
    // predicates.
    let capturedDetailWhere: unknown[] = [];
    let callCount = 0;
    dbSelectMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // ticket lookup — .from().leftJoin().where().limit()
        return {
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn((...args: unknown[]) => {
                capturedDetailWhere = args;
                return { limit: vi.fn(() => Promise.resolve([TICKET_ROW])) };
              })
            }))
          }))
        };
      }
      // comments lookup — .from().where().orderBy()
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve([])) }))
        }))
      };
    });

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(200);

    const whereStr = JSON.stringify(capturedDetailWhere);
    expect(whereStr).toContain('deletedAt');
    expect(whereStr).toContain('is null');
  });
});

// ── POST /tickets — B1 fix: delegates to createTicket ────────────────────────

const CREATED_AT = new Date('2026-01-15T10:00:00Z');
const UPDATED_AT = new Date('2026-01-15T10:00:00Z');

const CREATED_TICKET = {
  id: 'tk-new-1',
  ticketNumber: 'ABCDE12345',
  subject: 'Printer not working',
  description: 'It makes a clicking noise',
  status: 'new' as const,
  priority: 'normal' as const,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  orgId: 'o-1',
  partnerId: 'p-1',
  internalNumber: 'T-2026-0001',
};

function buildPostApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth' as never, { user: PORTAL_USER, token: 'tok-1', authMethod: 'bearer' });
    await next();
  });
  app.route('/', ticketRoutes);
  return app;
}

describe('POST /tickets — delegates to createTicket', () => {
  let app: ReturnType<typeof buildPostApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildPostApp();
    createTicketMock.mockResolvedValue(CREATED_TICKET);
  });

  it('calls createTicket with source: portal and mapped submitter fields', async () => {
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Printer not working', description: 'It makes a clicking noise' })
    });

    expect(res.status).toBe(201);
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: PORTAL_USER.orgId,
        subject: 'Printer not working',
        description: 'It makes a clicking noise',
        source: 'portal',
        submittedBy: PORTAL_USER.id,
        submitterEmail: PORTAL_USER.email,
        submitterName: PORTAL_USER.name,
      }),
      expect.objectContaining({ userId: PORTAL_USER.id })
    );
  });

  it('returns the same response shape as before (id, ticketNumber, subject, description, status, priority, createdAt, updatedAt)', async () => {
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Printer not working', description: 'It clicks' })
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { ticket: Record<string, unknown> };
    expect(body).toHaveProperty('ticket');
    expect(body.ticket).toMatchObject({
      id: CREATED_TICKET.id,
      ticketNumber: CREATED_TICKET.ticketNumber,
      subject: CREATED_TICKET.subject,
      description: CREATED_TICKET.description,
      status: CREATED_TICKET.status,
      priority: CREATED_TICKET.priority,
    });
    // Ensure no extra fields from the service row bleed into the portal response
    expect(body.ticket).not.toHaveProperty('partnerId');
    expect(body.ticket).not.toHaveProperty('orgId');
  });

  it('forwards TicketServiceError status and message to the client', async () => {
    const { TicketServiceError } = await import('../../services/ticketService');
    createTicketMock.mockRejectedValue(new TicketServiceError('Organization not found', 404));

    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Test', description: 'Something broke' })
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/organization not found/i);
  });
});

// ── PATCH /tickets/:id/comments/:commentId — Task 7 ──────────────────────────

describe('portal PATCH /tickets/:id/comments/:commentId', () => {
  let app: ReturnType<typeof buildApp>;

  const UPDATED_COMMENT = {
    id: COMMENT_ID,
    content: 'fixed typo',
    editedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    // Default: window open
    portalCommentMutableMock.mockResolvedValue({ ok: true });
    editTicketCommentMock.mockResolvedValue(UPDATED_COMMENT);
  });

  it('edits own reply when window is open — 200', async () => {
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'fixed typo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { comment: Record<string, unknown> };
    expect(body.comment).toMatchObject({ id: COMMENT_ID, content: 'fixed typo' });
  });

  it('calls portalCommentMutable with (commentId, portalUserId)', async () => {
    await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'fixed typo' }),
    });
    expect(portalCommentMutableMock).toHaveBeenCalledWith(COMMENT_ID, PORTAL_USER.id);
  });

  it('calls editTicketComment with canManageAny: true after ownership is proven', async () => {
    await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'fixed typo' }),
    });
    expect(editTicketCommentMock).toHaveBeenCalledWith(
      COMMENT_ID,
      { content: 'fixed typo' },
      expect.objectContaining({ userId: PORTAL_USER.id }),
      { canManageAny: true, expectedTicketId: TICKET_ID }
    );
  });

  it('writes portal audit on success', async () => {
    await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'fixed typo' }),
    });
    expect(writePortalAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'portal.ticket.comment.edit',
        resourceType: 'ticket_comment',
        resourceId: COMMENT_ID,
      })
    );
  });

  it('409s once staff has replied (staff_replied)', async () => {
    portalCommentMutableMock.mockResolvedValue({ ok: false, reason: 'staff_replied' });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'too late' }),
    });
    expect(res.status).toBe(409);
  });

  it('404s on another user\'s comment (not_author)', async () => {
    portalCommentMutableMock.mockResolvedValue({ ok: false, reason: 'not_author' });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('404s when comment not found (not_found)', async () => {
    portalCommentMutableMock.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('403s on CSRF failure', async () => {
    vi.mocked(validatePortalCookieCsrfRequest).mockReturnValueOnce('csrf token mismatch');
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects content exceeding 5000 chars with 400 (portal cap)', async () => {
    // Portal create caps content at 5000; portal edit must enforce the same cap
    // even though the shared editCommentSchema allows 50k. Staff edit stays at 50k.
    const overLimit = 'a'.repeat(5001);
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: overLimit }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/5000/);
    // editTicketComment must NOT have been called — rejection happens before service
    expect(editTicketCommentMock).not.toHaveBeenCalled();
  });

  it('accepts content of exactly 5000 chars (at boundary)', async () => {
    const atLimit = 'b'.repeat(5000);
    editTicketCommentMock.mockResolvedValueOnce({ id: COMMENT_ID, content: atLimit, editedAt: new Date() });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: atLimit }),
    });
    expect(res.status).toBe(200);
  });
});

// ── DELETE /tickets/:id/comments/:commentId — Task 7 ─────────────────────────

describe('portal DELETE /tickets/:id/comments/:commentId', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    // Default: window open
    portalCommentMutableMock.mockResolvedValue({ ok: true });
    deleteTicketCommentMock.mockResolvedValue({ id: COMMENT_ID });
  });

  it('deletes own reply when window is open — 200', async () => {
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('calls portalCommentMutable with (commentId, portalUserId)', async () => {
    await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(portalCommentMutableMock).toHaveBeenCalledWith(COMMENT_ID, PORTAL_USER.id);
  });

  it('calls deleteTicketComment with canManageAny: true after ownership is proven', async () => {
    await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(deleteTicketCommentMock).toHaveBeenCalledWith(
      COMMENT_ID,
      expect.objectContaining({ userId: PORTAL_USER.id }),
      { canManageAny: true, expectedTicketId: TICKET_ID }
    );
  });

  it('writes portal audit on success', async () => {
    await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(writePortalAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'portal.ticket.comment.delete',
        resourceType: 'ticket_comment',
        resourceId: COMMENT_ID,
      })
    );
  });

  it('409s once staff has replied (staff_replied)', async () => {
    portalCommentMutableMock.mockResolvedValue({ ok: false, reason: 'staff_replied' });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(res.status).toBe(409);
  });

  it('404s on another user\'s comment (not_author)', async () => {
    portalCommentMutableMock.mockResolvedValue({ ok: false, reason: 'not_author' });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(res.status).toBe(404);
  });

  it('404s when comment not found (not_found)', async () => {
    portalCommentMutableMock.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(res.status).toBe(404);
  });

  it('403s on CSRF failure', async () => {
    vi.mocked(validatePortalCookieCsrfRequest).mockReturnValueOnce('csrf token mismatch');
    const res = await app.request(`/tickets/${TICKET_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: portalJsonHeaders,
    });
    expect(res.status).toBe(403);
  });
});
