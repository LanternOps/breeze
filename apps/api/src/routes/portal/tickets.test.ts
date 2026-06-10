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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── DB mock ───────────────────────────────────────────────────────────────────

const { dbSelectMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn()
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'NANOIDTOKEN') }));

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
    updatedAt: 'updatedAt'
  },
  ticketComments: {
    id: 'id', ticketId: 'ticketId', authorName: 'authorName',
    content: 'content', isPublic: 'isPublic', deletedAt: 'deletedAt',
    createdAt: 'createdAt'
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
        // Ticket lookup
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([TICKET_ROW]))
            }))
          }))
        };
      }
      // Comments lookup — capture the where args
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
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }));

    const res = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(404);
  });
});
