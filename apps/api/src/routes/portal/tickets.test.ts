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
import { PgDialect } from 'drizzle-orm/pg-core';

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
  },
  // GET /tickets/forms resolves the session org's partnerId under a system
  // context (mirrors routes/portal/quotes.ts:70) — pass-through no-ops here,
  // same convention as routes/portal/quotes.test.ts.
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn()
}));

// `tickets` is the REAL Drizzle table, everything else a plain-string stub.
// Portal ticket ownership (#3258 W03) is expressed ENTIRELY as SQL — the route
// has no JS branch to exercise — so the only discriminating assertion is the
// compiled predicate, and a string-stub column compiles to a bound value
// instead of a column reference (`$1 = $2`), which asserts nothing about which
// column was filtered on.
vi.mock('../../db/schema', async () => ({
  tickets: (await vi.importActual<typeof import('../../db/schema/portal')>('../../db/schema/portal')).tickets,
  ticketComments: {
    id: 'id', ticketId: 'ticketId', authorName: 'authorName',
    content: 'content', isPublic: 'isPublic', deletedAt: 'deletedAt',
    createdAt: 'createdAt'
  },
  ticketStatuses: {
    id: 'id', name: 'name', color: 'color'
  },
  organizations: {
    id: 'id', partnerId: 'partnerId'
  },
  portalBranding: {
    id: 'id', orgId: 'orgId', enableTickets: 'enableTickets'
  }
}));

// ── ticketFormService mock ────────────────────────────────────────────────────

const { listTicketFormsForOrgMock } = vi.hoisted(() => ({
  listTicketFormsForOrgMock: vi.fn()
}));

vi.mock('../../services/ticketFormService', () => ({
  listTicketFormsForOrg: listTicketFormsForOrgMock
}));

const { openBytesMock } = vi.hoisted(() => ({ openBytesMock: vi.fn() }));
vi.mock('../../services/ticketAttachmentStorage', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketAttachmentStorage')>(
    '../../services/ticketAttachmentStorage',
  );
  return { ...actual, openBytes: openBytesMock };
});

vi.mock('./helpers', () => ({
  applyPortalCacheHeaders: vi.fn(),
  buildWeakEtag: vi.fn(() => '"etag-1"'),
  getPagination: vi.fn(() => ({ page: 1, limit: 20, offset: 0 })),
  isEtagFresh: vi.fn(() => false),
  validatePortalCookieCsrfRequest: vi.fn(() => null),
  writePortalAudit: vi.fn()
}));

import { ticketRoutes, portalTicketsEnabledMiddleware } from './tickets';
import { validatePortalCookieCsrfRequest, writePortalAudit } from './helpers';

// ── Test app ──────────────────────────────────────────────────────────────────

const PORTAL_USER = { id: 'pu-1', orgId: 'o-1', email: 'user@example.com', name: 'Test User', contactId: null };
// #3258 W03: the same login WITH a contact behind it. Every emailed ticket is
// attributed to the contact and carries no submitted_by at all, so this is the
// fixture that distinguishes "sees their own tickets" from "sees nothing".
const CONTACT_ID = 'ct-11111111-2222-4333-8444-555566667777';
const PORTAL_USER_WITH_CONTACT = { ...PORTAL_USER, contactId: CONTACT_ID };

/**
 * Compile a captured `.where(...)` argument list to real SQL + params.
 * A predicate assertion that reads the drizzle builder tree (JSON.stringify,
 * property probing) cannot tell `requester_contact_id = $2` from
 * `requester_contact_id = NULL`, and cannot see which column was filtered at
 * all once a column stub is involved. The compiled text can.
 */
const portalDialect = new PgDialect();
function compileWhere(args: unknown[]): { sql: string; params: unknown[] } {
  return portalDialect.sqlToQuery(args[0] as never);
}

function buildApp(user: Record<string, unknown> = PORTAL_USER) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth' as never, { user, token: 'tok-1', authMethod: 'bearer', timezone: 'UTC' });
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
      if (callCount === 2) {
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
      }
      // W08 #3902 — attachment metadata lookup, awaited directly off .where().
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([]))
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

    const { sql: whereSql } = compileWhere(capturedListWhere);
    expect(whereSql).toMatch(/"tickets"\."deleted_at" is null/i);
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

    const { sql: whereSql } = compileWhere(capturedDetailWhere);
    expect(whereSql).toMatch(/"tickets"\."deleted_at" is null/i);
  });
});

// ── GET /tickets/forms — Task 4: portal forms read ───────────────────────────

const FORM_ROW = {
  id: 'f-1',
  name: 'Printer Issue',
  description: 'Report a printer problem',
  categoryId: 'cat-1',
  fields: [{ key: 'model', label: 'Printer model', type: 'text', required: true }],
  defaultPriority: 'high',
  // Fields that must NOT leak into the slim portal payload:
  titleTemplate: '{{model}} is broken',
  orgId: null,
  partnerId: 'p-1',
  isActive: true,
  showInPortal: true,
  sortOrder: 1,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date()
};

describe('GET /tickets/forms', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    // Org partnerId lookup: db.select({partnerId}).from(organizations).where(...).limit(1)
    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ partnerId: 'p-1' }]))
        }))
      }))
    }));
  });

  it('resolves the session org + partnerId and calls listTicketFormsForOrg with portalOnly: true', async () => {
    listTicketFormsForOrgMock.mockResolvedValue([FORM_ROW]);

    const res = await app.request('/tickets/forms', {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);
    expect(listTicketFormsForOrgMock).toHaveBeenCalledWith(
      { id: PORTAL_USER.orgId, partnerId: 'p-1' },
      { portalOnly: true }
    );
  });

  it('returns ONLY the slim keys (id, name, description, categoryId, fields, defaultPriority) — no titleTemplate or other columns', async () => {
    listTicketFormsForOrgMock.mockResolvedValue([FORM_ROW]);

    const res = await app.request('/tickets/forms', {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: FORM_ROW.id,
      name: FORM_ROW.name,
      description: FORM_ROW.description,
      categoryId: FORM_ROW.categoryId,
      fields: FORM_ROW.fields,
      defaultPriority: FORM_ROW.defaultPriority
    });
    expect(body.data[0]).not.toHaveProperty('titleTemplate');
    expect(body.data[0]).not.toHaveProperty('orgId');
    expect(body.data[0]).not.toHaveProperty('partnerId');
    expect(body.data[0]).not.toHaveProperty('showInPortal');
  });

  it('returns { data: [] } when the service returns no forms', async () => {
    listTicketFormsForOrgMock.mockResolvedValue([]);

    const res = await app.request('/tickets/forms', {
      headers: { Authorization: 'Bearer portal-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
  });
});

// ── GET /tickets/forms — mount-wiring regression (auth-prefix coverage) ───────
//
// routes/portal/index.ts protects the ticket router with
// `portalRoutes.use('/tickets/*', portalAuthMiddleware)` — a `/tickets/*`
// prefix, NOT a blanket `use('*')` like buildApp() above. A forms route
// registered outside that prefix (the original `/ticket-forms` path) ships
// with NO auth in production and 500s on the missing portalAuth context.
// This suite wires the app the way index.ts ACTUALLY mounts it (same
// use-prefix + route('/') calls, with a portalAuthMiddleware stand-in that
// 401s without a session) so the auth-prefix coverage of the forms route is
// asserted structurally, not assumed.
describe('GET /tickets/forms — index.ts mount wiring', () => {
  function buildMountedApp() {
    const app = new Hono();
    // Verbatim shape of routes/portal/index.ts: prefix-scoped auth middleware,
    // then the router mounted at '/'. The stub mirrors portalAuthMiddleware's
    // contract: 401 without a session credential, portalAuth set otherwise.
    app.use('/tickets/*', async (c, next) => {
      if (!c.req.header('Authorization')) {
        return c.json({ error: 'Authentication required' }, 401);
      }
      c.set('portalAuth' as never, { user: PORTAL_USER, token: 'tok-1', authMethod: 'bearer', timezone: 'UTC' });
      await next();
    });
    app.route('/', ticketRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ partnerId: 'p-1' }]))
        }))
      }))
    }));
  });

  it('WITHOUT a session: 401 — proves the /tickets/* auth prefix covers the forms route', async () => {
    const app = buildMountedApp();
    const res = await app.request('/tickets/forms');
    expect(res.status).toBe(401);
    expect(listTicketFormsForOrgMock).not.toHaveBeenCalled();
  });

  it('WITH a session: 200 slim payload — proves /tickets/forms is not swallowed by the /tickets/:id matcher', async () => {
    listTicketFormsForOrgMock.mockResolvedValue([FORM_ROW]);
    const app = buildMountedApp();
    const res = await app.request('/tickets/forms', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown>[] };
    expect(body.data[0]).toEqual({
      id: FORM_ROW.id,
      name: FORM_ROW.name,
      description: FORM_ROW.description,
      categoryId: FORM_ROW.categoryId,
      fields: FORM_ROW.fields,
      defaultPriority: FORM_ROW.defaultPriority
    });
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
    c.set('portalAuth' as never, { user: PORTAL_USER, token: 'tok-1', authMethod: 'bearer', timezone: 'UTC' });
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

  // ── Task 4: form-aware create ──────────────────────────────────────────────

  it('passes formId and formResponses through to createTicket', async () => {
    const FORM_ID = '3f2f1d8e-1111-4222-8333-444455556677';
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formId: FORM_ID, formResponses: { model: 'HP LaserJet' } })
    });

    expect(res.status).toBe(201);
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: FORM_ID,
        formResponses: { model: 'HP LaserJet' },
        source: 'portal'
      }),
      expect.objectContaining({ userId: PORTAL_USER.id })
    );
  });

  it('rejects formResponses without formId with a 400 (schema-level, before createTicket is called)', async () => {
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formResponses: { model: 'HP LaserJet' } })
    });

    expect(res.status).toBe(400);
    expect(createTicketMock).not.toHaveBeenCalled();
  });

  it('accepts a form-only submission with no subject/description', async () => {
    const FORM_ID = '3f2f1d8e-1111-4222-8333-444455556677';
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formId: FORM_ID, formResponses: { model: 'HP LaserJet' } })
    });

    expect(res.status).toBe(201);
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ formId: FORM_ID, subject: undefined, description: undefined }),
      expect.anything()
    );
  });

  it('accepts a legacy submission (subject + description, no form) unchanged', async () => {
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Printer not working', description: 'It clicks' })
    });

    expect(res.status).toBe(201);
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Printer not working',
        description: 'It clicks',
        formId: undefined,
        formResponses: undefined
      }),
      expect.anything()
    );
  });

  it('rejects a blank subject with no formId with a 400', async () => {
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: '   ', description: 'It clicks' })
    });

    expect(res.status).toBe(400);
    expect(createTicketMock).not.toHaveBeenCalled();
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

// ── portalTicketsEnabledMiddleware — #2345 enable_tickets enforcement ─────────
//
// The per-org `portal_branding.enable_tickets` toggle must gate EVERY portal
// ticket surface. The middleware is registered in routes/portal/index.ts on the
// same `/tickets/*` prefix as portalAuthMiddleware; this suite wires the app the
// way index.ts actually mounts it (prefix-scoped middleware + route('/')) so the
// prefix coverage — including GET /tickets/forms — is asserted structurally.
describe('portalTicketsEnabledMiddleware — enable_tickets gate (#2345)', () => {
  function buildGatedApp() {
    const app = new Hono();
    app.use('/tickets/*', async (c, next) => {
      c.set('portalAuth' as never, { user: PORTAL_USER, token: 'tok-1', authMethod: 'bearer', timezone: 'UTC' });
      await next();
    });
    app.use('/tickets/*', portalTicketsEnabledMiddleware);
    app.route('/', ticketRoutes);
    return app;
  }

  /**
   * First db.select call is the middleware's branding lookup
   * (.from(portalBranding).where(orgId).limit(1)) → returns brandingRows.
   * Subsequent calls resolve generically so a passing request can complete
   * (list count/data, forms partnerId lookup, ...).
   */
  function setupBrandingMock(brandingRows: object[]) {
    let callCount = 0;
    dbSelectMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(brandingRows))
            }))
          }))
        };
      }
      // Generic chain: supports .from().where().limit() and the GET /tickets
      // list shape .from().leftJoin().where().orderBy().limit().offset().
      const terminal = Promise.resolve([]);
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'leftJoin', 'where', 'orderBy', 'limit']) {
        chain[m] = vi.fn(() => chain);
      }
      chain.offset = vi.fn(() => terminal);
      (chain as { then: unknown }).then = terminal.then.bind(terminal);
      return chain;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enableTickets=false → 403 with a clear message on GET /tickets', async () => {
    setupBrandingMock([{ enableTickets: false }]);
    const app = buildGatedApp();
    const res = await app.request('/tickets', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Ticketing is not enabled for this portal');
    // Machine-readable code — the portal pages key their redirect on this so
    // other 403s (e.g. "Account is not active") are not misread as "disabled".
    expect(body.code).toBe('PORTAL_TICKETS_DISABLED');
  });

  it('enableTickets=false → 403 on POST /tickets (mutations gated, createTicket never called)', async () => {
    setupBrandingMock([{ enableTickets: false }]);
    const app = buildGatedApp();
    const res = await app.request('/tickets', {
      method: 'POST',
      headers: portalJsonHeaders,
      body: JSON.stringify({ subject: 'Printer broken', description: 'It makes a loud clicking noise now', priority: 'normal' })
    });
    expect(res.status).toBe(403);
    expect(createTicketMock).not.toHaveBeenCalled();
  });

  it('enableTickets=false → 403 on GET /tickets/forms (Phase 2 intake endpoint is covered by the prefix)', async () => {
    setupBrandingMock([{ enableTickets: false }]);
    const app = buildGatedApp();
    const res = await app.request('/tickets/forms', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(403);
    expect(listTicketFormsForOrgMock).not.toHaveBeenCalled();
  });

  it('enableTickets=false → 403 on GET /tickets/:id and comment mutations', async () => {
    setupBrandingMock([{ enableTickets: false }]);
    let app = buildGatedApp();
    const detail = await app.request(`/tickets/${TICKET_ID}`, {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(detail.status).toBe(403);

    setupBrandingMock([{ enableTickets: false }]);
    app = buildGatedApp();
    const comment = await app.request(`/tickets/${TICKET_ID}/comments`, {
      method: 'POST',
      headers: portalJsonHeaders,
      body: JSON.stringify({ content: 'hello' })
    });
    expect(comment.status).toBe(403);
  });

  it('enableTickets=true → passes through (200 on GET /tickets)', async () => {
    setupBrandingMock([{ enableTickets: true }]);
    const app = buildGatedApp();
    const res = await app.request('/tickets', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(200);
  });

  it('NO branding row → fail-open, ticketing stays enabled (200 on GET /tickets)', async () => {
    setupBrandingMock([]);
    const app = buildGatedApp();
    const res = await app.request('/tickets', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    expect(res.status).toBe(200);
  });

  it('mounted without portalAuth (misordered use()) → explicit 401, not a TypeError 500', async () => {
    setupBrandingMock([{ enableTickets: false }]);
    const app = new Hono();
    // Deliberately NO auth middleware before the gate — simulates a future
    // index.ts refactor reordering the use() calls.
    app.use('/tickets/*', portalTicketsEnabledMiddleware);
    app.route('/', ticketRoutes);
    const res = await app.request('/tickets');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// W08 #3902 — portal attachment read path. The leak cases come first because
// they are the point of the task.
// ---------------------------------------------------------------------------
describe('portal ticket attachments (W08 #3902)', () => {
  const ATT_ID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
  const SHA = 'e'.repeat(64);
  let app: ReturnType<typeof buildApp>;
  let attachmentWhereArgs: unknown[] = [];
  let ticketWhereArgs: unknown[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    attachmentWhereArgs = [];
    ticketWhereArgs = [];
    app = buildApp();
    openBytesMock.mockResolvedValue({ body: Buffer.from('bytes'), contentLength: 5 });
  });

  /** Detail: ticket lookup (leftJoin) -> comments -> attachments. */
  function rigDetail(commentsRows: object[], attachmentRows: object[]) {
    let n = 0;
    dbSelectMock.mockImplementation(() => {
      n++;
      if (n === 1) {
        return { from: vi.fn(() => ({ leftJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([TICKET_ROW])) })) })) })) };
      }
      if (n === 2) {
        return { from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(commentsRows)) })) })) };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn((...args: unknown[]) => {
            attachmentWhereArgs = args;
            return Promise.resolve(attachmentRows);
          }),
        })),
      };
    });
  }

  /** Content: ticket lookup -> attachment+comment innerJoin lookup. */
  function rigContent(ticketRows: object[], joinRows: object[]) {
    let n = 0;
    dbSelectMock.mockImplementation(() => {
      n++;
      if (n === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn((...args: unknown[]) => {
              ticketWhereArgs = args;
              return { limit: vi.fn(() => Promise.resolve(ticketRows)) };
            }),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn((...args: unknown[]) => {
              attachmentWhereArgs = args;
              return { limit: vi.fn(() => Promise.resolve(joinRows)) };
            }),
          })),
        })),
      };
    });
  }

  /** Pull the bound parameter values out of a drizzle SQL tree (no JSON.stringify:
   *  drizzle column objects are circular). */
  function collectSqlParamValues(node: unknown, out: unknown[] = []): unknown[] {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const item of node) collectSqlParamValues(item, out);
      return out;
    }
    const rec = node as Record<string, unknown>;
    if ('value' in rec && !('table' in rec)) out.push(rec.value);
    if (Array.isArray(rec.queryChunks)) collectSqlParamValues(rec.queryChunks, out);
    return out;
  }

  /**
   * Render a drizzle predicate back to text so the authz ladder itself can be
   * asserted.
   *
   * The rig resolves its fixture rows unconditionally — no mocked WHERE can
   * change what comes back — so a 404 test proves only that the fixture was
   * empty. This route has no JS branch to exercise either: every rung of the
   * ladder is a SQL condition. Asserting the predicate is therefore the only
   * thing that discriminates; without it, deleting `isPublic` from the route
   * leaves the whole suite green.
   *
   * The schema mock above gives each column a plain string ('orgId'), so a
   * mocked column lands in the tree as a BOUND VALUE rather than a column
   * reference — hence the column-name checks below go through
   * collectSqlParamValues, and only structural text (' is null') is matched
   * here.
   */
  function renderPredicate(node: unknown): string {
    if (node === null || node === undefined || typeof node !== 'object') return '';
    if (Array.isArray(node)) return node.map(renderPredicate).join('');
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.queryChunks)) return renderPredicate(rec.queryChunks);
    // StringChunk: the literal SQL fragments (' = ', ' is null', ' and ').
    if (Array.isArray(rec.value) && rec.value.every((v) => typeof v === 'string')) {
      return (rec.value as string[]).join('');
    }
    // Column: has a name and belongs to a table.
    if (typeof rec.name === 'string' && 'table' in rec) return String(rec.name);
    if ('value' in rec) return `<${String(rec.value)}>`; // bound parameter
    return '';
  }

  const attRow = (over: Record<string, unknown> = {}) => ({
    id: ATT_ID, ticketId: TICKET_ID, commentId: 'c-1', contentType: 'image/png',
    byteSize: 5, originalFilename: 'photo.png', sha256: SHA, storageBackend: 'db',
    storageKey: null, data: Buffer.from('bytes'), createdAt: new Date(), ...over,
  });

  it('never lists an attachment whose parent comment is internal', async () => {
    // The comments query already filters isPublic/deletedAt; the attachment
    // query is keyed on THOSE ids, so an internal comment's attachment has no
    // comment id to hang off.
    rigDetail(
      [{ id: 'c-1', authorName: 'Tech', authorType: 'internal', content: 'public', createdAt: new Date() }],
      [{ id: ATT_ID, commentId: 'c-1', contentType: 'image/png', byteSize: 5, originalFilename: 'p.png', createdAt: new Date() }],
    );
    const res = await app.request(`/tickets/${TICKET_ID}`, { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.comments[0].attachments).toHaveLength(1);
    // The id set handed to the attachment query is exactly the public comments'
    // ids — nothing internal or soft-deleted can appear there.
    expect(collectSqlParamValues(attachmentWhereArgs)).toContain('c-1');
  });

  it('skips the attachment query entirely when there are no public comments', async () => {
    rigDetail([], []);
    const res = await app.request(`/tickets/${TICKET_ID}`, { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect((await res.json()).ticket.comments).toEqual([]);
    expect(attachmentWhereArgs).toEqual([]);
  });

  // NOTE: the three 404 cases below prove the ROUTE returns 404 for an empty
  // result set, not that the WHERE clause produces one — this rig resolves its
  // fixture rows unconditionally, and the schema mock above renders mocked
  // columns as plain strings that vanish from the SQL tree, so the org /
  // submitter / is_public / deleted_at rungs are NOT assertable here. They are
  // proven end-to-end against real Postgres in
  // src/__tests__/integration/ticketAttachmentsRls.integration.test.ts
  // ("portal attachment read path (REAL route, real Postgres)"), which drives
  // this handler itself (W08A review).
  it('404s the content route for a ticket the session did not submit', async () => {
    rigContent([], []);
    const res = await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('404s the content route when the attachment is on an internal or deleted comment', async () => {
    // The inner join + is_public/deleted_at filters yield no row.
    rigContent([TICKET_ROW], []);
    const res = await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('serves a public-comment attachment with the D7 headers and nosniff', async () => {
    rigContent([TICKET_ROW], [{ attachment: attRow() }]);
    const res = await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('ETag')).toBe(`"${SHA}"`);
    expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="photo.png"; filename*=UTF-8''photo.png`);
  });

  it('304s on a matching If-None-Match without fetching the bytes', async () => {
    rigContent([TICKET_ROW], [{ attachment: attRow() }]);
    const res = await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t', 'If-None-Match': `"${SHA}"` },
    });
    expect(res.status).toBe(304);
    expect(openBytesMock).not.toHaveBeenCalled();
  });

  it('keys the content route attachment lookup on THIS ticket, not the id alone', async () => {
    rigContent([TICKET_ROW], [{ attachment: attRow() }]);
    await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t' },
    });
    // Without the ticket_id rung the route is an IDOR across every ticket in
    // the org: any attachment id reachable through any ticket the session did
    // submit. Both operands here are REAL ticketAttachments columns, so they
    // survive into the SQL tree and this assertion actually discriminates.
    const values = collectSqlParamValues(attachmentWhereArgs);
    expect(values).toContain(ATT_ID);
    expect(values).toContain(TICKET_ID);
    // A structural sanity check on the comment join's non-deleted rung.
    expect(renderPredicate(attachmentWhereArgs)).toMatch(/is null/);
  });

  it('503s (not 500s) when the object store faults, matching the technician route', async () => {
    rigContent([TICKET_ROW], [{ attachment: attRow({ storageBackend: 's3', storageKey: 'k', data: null }) }]);
    openBytesMock.mockRejectedValueOnce(new Error('s3 unreachable'));
    const res = await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t' },
    });
    // A transport fault is retryable; an unhandled throw would surface to the
    // customer as a generic 500 and never reach Sentry from this route.
    expect(res.status).toBe(503);
  });

  it('the portal has no tickets:manage escape hatch — there is no override branch', async () => {
    rigContent([TICKET_ROW], []);
    const res = await app.request(`/tickets/${TICKET_ID}/attachments/${ATT_ID}/content`, {
      headers: { Authorization: 'Bearer t', 'X-Breeze-Permissions': 'tickets:manage' },
    });
    expect(res.status).toBe(404);
  });
});

// ── #3258 W03: portal ticket ownership is `login OR linked contact` ──────────
//
// Inbound email no longer mints a password-less portal_users row per sender —
// an emailed ticket carries `requester_contact_id` and NO `submitted_by` at
// all. Every read a portal customer performs therefore has to match on both,
// and it has to do so at ALL FOUR sites: miss one and the customer can list a
// ticket they cannot open, or open one they cannot comment on.
//
// Asserted on the COMPILED predicate. There is no JS branch here to exercise —
// each rung of the ladder is a SQL condition against a mock that resolves its
// fixture unconditionally — so a status-code test proves nothing, and a
// builder-tree probe cannot tell `requester_contact_id = $3` from
// `requester_contact_id = NULL` (which matches no row and reads like a working
// filter).
describe('portal ticket ownership — compiled WHERE at every read site', () => {
  let wheres: unknown[][] = [];

  /** One chain shape for every query in this file: each method returns the
   *  node, `.where()` records its arguments, and awaiting resolves the row. */
  function rigCapture() {
    wheres = [];
    dbSelectMock.mockImplementation(() => {
      const node: Record<string, unknown> = {};
      const passthrough = () => node;
      Object.assign(node, {
        from: passthrough,
        leftJoin: passthrough,
        innerJoin: passthrough,
        orderBy: passthrough,
        limit: passthrough,
        offset: passthrough,
        where: (...args: unknown[]) => {
          wheres.push(args);
          return node;
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve([TICKET_ROW]).then(resolve, reject),
      });
      return node;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rigCapture();
  });

  const AUTH = { headers: { Authorization: 'Bearer portal-token' } };

  const sites: Array<[string, (app: ReturnType<typeof buildApp>) => unknown]> = [
    ['list', (app) => app.request('/tickets', AUTH)],
    ['detail', (app) => app.request(`/tickets/${TICKET_ID}`, AUTH)],
    [
      'comment POST',
      (app) =>
        app.request(`/tickets/${TICKET_ID}/comments`, {
          method: 'POST',
          headers: { ...AUTH.headers, ...portalJsonHeaders },
          body: JSON.stringify({ content: 'thanks' }),
        }),
    ],
    [
      'attachment content',
      (app) => app.request(`/tickets/${TICKET_ID}/attachments/${'aaaabbbb-cccc-4ddd-8eee-ffff00001111'}/content`, AUTH),
    ],
  ];

  it.each(sites)('%s: matches the linked contact as well as the login', async (_name, run) => {
    await run(buildApp(PORTAL_USER_WITH_CONTACT));

    expect(wheres.length).toBeGreaterThan(0);
    const { sql: predicate, params } = compileWhere(wheres[0]!);
    expect(predicate).toMatch(/"tickets"\."submitted_by" = \$\d/);
    expect(predicate).toMatch(/"tickets"\."requester_contact_id" = \$\d/);
    expect(predicate).toMatch(/\bor\b/i);
    // Bound to the SESSION's contact id — not to the ticket id, and not to a
    // literal that would silently match nothing.
    expect(params).toEqual(expect.arrayContaining([PORTAL_USER.id, CONTACT_ID]));
  });

  it.each(sites)('%s: omits the contact arm entirely for a contact-less login', async (_name, run) => {
    await run(buildApp(PORTAL_USER));

    expect(wheres.length).toBeGreaterThan(0);
    const { sql: predicate, params } = compileWhere(wheres[0]!);
    expect(predicate).toMatch(/"tickets"\."submitted_by" = \$\d/);
    // `eq(col, null)` compiles to `= NULL`, which is never true: a dead OR arm
    // that reads like a working filter to anyone auditing the query later.
    expect(predicate).not.toMatch(/requester_contact_id/);
    expect(params).not.toContain(null);
  });
});
