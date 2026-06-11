import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { serviceMocks, dbSelectMock, dbGroupByMock, authRef, lastWhereArgs, writeRouteAuditMock } = vi.hoisted(() => {
  const lastWhereArgs: { conditions: unknown[] }[] = [];
  return {
    serviceMocks: {
      createTicket: vi.fn(),
      changeTicketStatus: vi.fn(),
      assignTicket: vi.fn(),
      addTicketComment: vi.fn(),
      linkAlertToTicket: vi.fn(),
      unlinkAlertFromTicket: vi.fn(),
      updateTicketFields: vi.fn(),
      getAssigneeForValidation: vi.fn(),
    },
    dbSelectMock: vi.fn(),
    dbGroupByMock: vi.fn(),
    writeRouteAuditMock: vi.fn(),
    lastWhereArgs,
    /** Mutable ref so individual tests can override the injected auth context. */
    authRef: {
      current: {
        scope: 'partner' as string,
        user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
        partnerId: 'p-1' as string | null,
        orgId: null as string | null,
        accessibleOrgIds: null as string[] | null,
        orgCondition: () => undefined,
        canAccessOrg: (_id: string) => true as boolean
      }
    }
  };
});

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock
}));

vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, ...serviceMocks };
});

// Mirror the REAL middleware contract: authMiddleware is the ONLY thing that
// populates c.get('auth'); requireScope 401s when it is missing (exactly the
// production failure mode when authMiddleware isn't wired into the router —
// regression for the Phase 1a routes shipping without it).
vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  // Real implementation, not a re-implementation: siteAccessCheck is a pure
  // function and the single source of truth for site-allowlist semantics —
  // re-exporting it keeps these route tests honest if those semantics change.
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

vi.mock('../../db', () => ({
  // Passthroughs for the service's system-scope validation reads (RLS concern,
  // invisible to these mocked-db tests).
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              // 3 leftJoins: list endpoint (tickets + orgs + devices + users)
              // and the GET /:id decoration query (where → limit(1))
              where: vi.fn((...args: unknown[]) => {
                lastWhereArgs.push({ conditions: args });
                return {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(() => ({ offset: vi.fn(() => dbSelectMock()) }))
                  })),
                  limit: vi.fn(() => dbSelectMock())
                };
              })
            })),
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => dbSelectMock()) }))
              }))
            }))
          })),
          // single leftJoin → where (e.g. ticketAlertLinks joined with alerts)
          where: vi.fn(() => Promise.resolve(dbSelectMock() ?? []))
        })),
        where: vi.fn(() => ({
          orderBy: vi.fn(() => Promise.resolve([])),
          groupBy: vi.fn(() => dbGroupByMock()),
          // getScopedTicketOr404 and GET /:id single-row lookups both use .limit(1)
          limit: vi.fn(() => dbSelectMock())
        }))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
      }))
    }))
  }
}));
vi.mock('../../db/schema', () => ({
  tickets: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', status: 'status',
    priority: 'priority', assignedTo: 'assignedTo', categoryId: 'categoryId',
    internalNumber: 'internalNumber', subject: 'subject', createdAt: 'createdAt',
    updatedAt: 'updatedAt', dueDate: 'dueDate', deviceId: 'deviceId',
    source: 'source', slaBreachedAt: 'slaBreachedAt', firstResponseAt: 'firstResponseAt',
    resolutionSlaMinutes: 'resolutionSlaMinutes'
  },
  ticketComments: { ticketId: 'ticketId', deletedAt: 'deletedAt', createdAt: 'createdAt' },
  ticketCategories: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId', id: 'id', linkType: 'linkType' },
  alerts: { id: 'id', title: 'title', severity: 'severity', status: 'status' },
  devices: { id: 'id', hostname: 'hostname', orgId: 'orgId', siteId: 'siteId' },
  organizations: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' }
}));

// Import the hub router (./index), not ./tickets directly — the hub is what
// apps/api/src/index.ts mounts and is where authMiddleware is applied.
import { ticketsRoutes } from './index';
// Real class (the service mock spreads importActual), so handleServiceError's
// instanceof check in the route works against errors thrown by the mocks.
import { TicketServiceError } from '../../services/ticketService';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const ORG_ID    = '3f2f1d8e-1111-4222-8333-444455556666';
const STUB_TICKET = { id: TICKET_ID, orgId: 'org-1', partnerId: 'p-1', subject: 'Printer' };

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean
};

function makeApp() {
  const app = new Hono();
  app.route('/tickets', ticketsRoutes);
  return app;
}

function resetAuth() {
  authRef.current = { ...DEFAULT_AUTH, canAccessOrg: () => true };
  lastWhereArgs.length = 0;
}

describe('GET /tickets', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns paginated data', async () => {
    dbSelectMock.mockResolvedValue([{ id: 't-1', internalNumber: 'T-2026-0001', subject: 'Printer' }]);
    const res = await makeApp().request('/tickets?statusGroup=open');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
  });

  it('selects resolutionSlaMinutes and returns it in list rows (SLA chips)', async () => {
    dbSelectMock.mockResolvedValue([
      { id: 't-1', internalNumber: 'T-2026-0001', subject: 'Printer', resolutionSlaMinutes: 240 }
    ]);
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ resolutionSlaMinutes: 240 });

    // The selection object passed to db.select must include the column —
    // the mock returns rows verbatim, so assert the query shape too.
    const { db } = await import('../../db');
    const selectionCalls = (db.select as any).mock.calls.filter(
      (args: unknown[]) => args[0] && typeof args[0] === 'object'
    );
    expect(selectionCalls.some(
      (args: any[]) => 'resolutionSlaMinutes' in args[0]
    )).toBe(true);
  });

  it('rejects an invalid statusGroup', async () => {
    const res = await makeApp().request('/tickets?statusGroup=weird');
    expect(res.status).toBe(400);
  });

  it('403 when partner scope has null partnerId (broken context)', async () => {
    authRef.current = { ...DEFAULT_AUTH, scope: 'partner', partnerId: null };
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Partner context required');
  });

  it('scoped org query includes a WHERE arg (org scope adds condition)', async () => {
    authRef.current = {
      ...DEFAULT_AUTH,
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      canAccessOrg: () => true
    };
    dbSelectMock.mockResolvedValue([]);
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(200);
    // At least one where call was recorded with a defined condition arg
    expect(lastWhereArgs.length).toBeGreaterThan(0);
    expect(lastWhereArgs[0]!.conditions.length).toBeGreaterThan(0);
  });

  it('403 when organization scope has no orgId', async () => {
    authRef.current = { ...DEFAULT_AUTH, scope: 'organization', orgId: null, partnerId: null };
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Organization context required');
  });

  it('applies a deviceId filter condition when ?deviceId= is provided', async () => {
    const DEVICE_ID = '9a8b7c6d-1111-4222-8333-444455556666';
    dbSelectMock.mockResolvedValue([]);
    const res = await makeApp().request(`/tickets?deviceId=${DEVICE_ID}`);
    expect(res.status).toBe(200);
    // The where condition is and(partnerCond, eq(tickets.deviceId, DEVICE_ID));
    // the mocked schema column is the string 'deviceId', so the serialized SQL
    // must mention both the column and the bound uuid value.
    expect(lastWhereArgs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(lastWhereArgs[0]!.conditions);
    expect(serialized).toContain('deviceId');
    expect(serialized).toContain(DEVICE_ID);
  });

  it('rejects a non-uuid deviceId', async () => {
    const res = await makeApp().request('/tickets?deviceId=not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('POST /tickets', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('creates via ticketService and returns 201', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', internalNumber: 'T-2026-0001' });
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'Printer offline' })
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Printer offline', source: 'manual' }),
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('400s on a missing subject', async () => {
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(400);
  });

  it('maps TicketServiceError status through (404 org)', async () => {
    const { TicketServiceError } = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
    serviceMocks.createTicket.mockRejectedValue(new TicketServiceError('Organization not found', 404));
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'x' })
    });
    expect(res.status).toBe(404);
  });

  it('403 when canAccessOrg returns false for the body orgId', async () => {
    authRef.current = { ...DEFAULT_AUTH, canAccessOrg: () => false };
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'Unauthorized ticket' })
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Access to this organization denied');
    expect(serviceMocks.createTicket).not.toHaveBeenCalled();
  });
});

describe('GET /tickets/stats', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('aggregates open / unassigned / mine / breached counts via groupBy', async () => {
    // auth user id is 'u-1' (set in requireScope mock above)
    // Rows: open+assigned-to-u1+not-breached(3), new+unassigned+breached(2)
    const mockRows = [
      { status: 'open', assignedTo: 'u-1', breached: false, count: 3 },
      { status: 'new',  assignedTo: null,   breached: true,  count: 2 }
    ];
    dbGroupByMock.mockResolvedValue(mockRows);

    const res = await makeApp().request('/tickets/stats');
    expect(res.status).toBe(200);

    const body = await res.json();
    // open: both rows have open-statuses ('open','new') → 3+2 = 5
    // unassigned: row 2 has no assignedTo → 2
    // mine: row 1 has assignedTo === 'u-1' → 3
    // breached: row 2 has breached=true → 2
    expect(body.data).toEqual({ open: 5, unassigned: 2, mine: 3, breached: 2 });

    // Ensure groupBy was used (not orderBy) — the mock resolves via dbGroupByMock
    expect(dbGroupByMock).toHaveBeenCalledTimes(1);
  });

  it('403 when partner scope has null partnerId (broken context)', async () => {
    authRef.current = { ...DEFAULT_AUTH, scope: 'partner', partnerId: null };
    const res = await makeApp().request('/tickets/stats');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Partner context required');
  });
});

describe('GET /tickets/:id — scoped pre-check', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns 404 when getScopedTicketOr404 finds no row even if service would succeed', async () => {
    // The scoped SELECT returns nothing (out-of-scope or missing ticket)
    dbSelectMock.mockResolvedValue([]);

    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Ticket not found');
  });

  it('returns the ticket when the scoped lookup resolves a row', async () => {
    // First call: getScopedTicketOr404 (the .limit(1) select)
    // Second call onwards: decoration + child queries (alertLinks) — return empty arrays
    dbSelectMock
      .mockResolvedValueOnce([STUB_TICKET]) // scoped ticket lookup
      .mockResolvedValue([]);               // decoration + alert links child queries

    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: TICKET_ID, subject: 'Printer' });
  });

  it('decorates the detail response with orgName, deviceHostname, assigneeName', async () => {
    dbSelectMock
      .mockResolvedValueOnce([STUB_TICKET]) // scoped ticket lookup
      .mockResolvedValueOnce([{ orgName: 'Acme Corp', deviceHostname: 'WS-042', assigneeName: 'Tess Tech' }]) // decoration query
      .mockResolvedValue([]);               // alert links child query

    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Strictly additive: raw row fields still present alongside the decoration.
    expect(body.data).toMatchObject({
      id: TICKET_ID,
      subject: 'Printer',
      orgName: 'Acme Corp',
      deviceHostname: 'WS-042',
      assigneeName: 'Tess Tech'
    });
    expect(body.data).toHaveProperty('comments');
    expect(body.data).toHaveProperty('alertLinks');
  });

  it('decoration is null-safe for tickets with no device or assignee', async () => {
    dbSelectMock
      .mockResolvedValueOnce([STUB_TICKET]) // scoped ticket lookup
      .mockResolvedValueOnce([{ orgName: 'Acme Corp', deviceHostname: null, assigneeName: null }]) // left joins miss
      .mockResolvedValue([]);               // alert links child query

    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.orgName).toBe('Acme Corp');
    expect(body.data.deviceHostname).toBeNull();
    expect(body.data.assigneeName).toBeNull();
  });

  it('decoration falls back to nulls when the decoration query returns no row', async () => {
    dbSelectMock
      .mockResolvedValueOnce([STUB_TICKET]) // scoped ticket lookup
      .mockResolvedValue([]);               // decoration returns nothing + alert links

    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.orgName).toBeNull();
    expect(body.data.deviceHostname).toBeNull();
    expect(body.data.assigneeName).toBeNull();
  });
});

describe('POST /tickets/:id/status', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('calls changeTicketStatus with id, status, opts, actor and returns 200', async () => {
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]); // getScopedTicketOr404
    serviceMocks.changeTicketStatus.mockResolvedValue({ ...STUB_TICKET, status: 'resolved' });

    const res = await makeApp().request(`/tickets/${TICKET_ID}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', resolutionNote: 'Fixed it' })
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.changeTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      'resolved',
      expect.objectContaining({ resolutionNote: 'Fixed it' }),
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('returns 404 when scoped pre-check finds no ticket', async () => {
    dbSelectMock.mockResolvedValueOnce([]); // getScopedTicketOr404 → not found
    const res = await makeApp().request(`/tickets/${TICKET_ID}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });

  it('maps 409 TicketServiceError through from service', async () => {
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]);
    const { TicketServiceError } = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
    serviceMocks.changeTicketStatus.mockRejectedValue(new TicketServiceError('Cannot transition', 409));

    const res = await makeApp().request(`/tickets/${TICKET_ID}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' })
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /tickets/:id/assign', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const ASSIGNEE_ID = '5a6b7c8d-1234-4321-abcd-000011112222';

  it('calls assignTicket with id, assigneeId, actor and returns 200', async () => {
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]);
    serviceMocks.assignTicket.mockResolvedValue({ ...STUB_TICKET, assignedTo: ASSIGNEE_ID });

    const res = await makeApp().request(`/tickets/${TICKET_ID}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeId: ASSIGNEE_ID })
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.assignTicket).toHaveBeenCalledWith(
      TICKET_ID,
      ASSIGNEE_ID,
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('returns 404 when scoped pre-check finds no ticket', async () => {
    dbSelectMock.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/tickets/${TICKET_ID}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeId: ASSIGNEE_ID })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });
});

describe('POST /tickets/:id/comments', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('calls addTicketComment and returns 201', async () => {
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]);
    serviceMocks.addTicketComment.mockResolvedValue({
      comment: { id: 'c-1', content: 'On it', isPublic: true },
      firstResponseStamped: true
    });

    const res = await makeApp().request(`/tickets/${TICKET_ID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'On it', isPublic: true })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: 'c-1', content: 'On it' });
  });

  it('returns 404 when scoped pre-check finds no ticket', async () => {
    dbSelectMock.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/tickets/${TICKET_ID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi', isPublic: false })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.addTicketComment).not.toHaveBeenCalled();
  });
});

describe('POST /tickets/:id/alerts', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('calls linkAlertToTicket and returns 201', async () => {
    const ALERT_ID = '4f3f2e9f-2222-4333-9444-555566667777';
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]);
    serviceMocks.linkAlertToTicket.mockResolvedValue({ id: 'link-1', ticketId: TICKET_ID, alertId: ALERT_ID });

    const res = await makeApp().request(`/tickets/${TICKET_ID}/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId: ALERT_ID })
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.linkAlertToTicket).toHaveBeenCalledWith(
      TICKET_ID,
      ALERT_ID,
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('returns 404 when scoped pre-check finds no ticket', async () => {
    const ALERT_ID = '4f3f2e9f-2222-4333-9444-555566667777';
    dbSelectMock.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/tickets/${TICKET_ID}/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId: ALERT_ID })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.linkAlertToTicket).not.toHaveBeenCalled();
  });
});

describe('DELETE /tickets/:id/alerts/:alertId', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const ALERT_ID = '4f3f2e9f-2222-4333-9444-555566667777';

  it('calls unlinkAlertFromTicket and returns 200', async () => {
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]);
    serviceMocks.unlinkAlertFromTicket.mockResolvedValue({ ticketId: TICKET_ID, alertId: ALERT_ID });

    const res = await makeApp().request(`/tickets/${TICKET_ID}/alerts/${ALERT_ID}`, {
      method: 'DELETE'
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.unlinkAlertFromTicket).toHaveBeenCalledWith(
      TICKET_ID,
      ALERT_ID,
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('returns 404 when scoped pre-check finds no ticket', async () => {
    dbSelectMock.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/tickets/${TICKET_ID}/alerts/${ALERT_ID}`, {
      method: 'DELETE'
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.unlinkAlertFromTicket).not.toHaveBeenCalled();
  });
});

describe('PATCH /tickets/:id — delegates to updateTicketFields', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns 404 when the scoped pre-check finds no ticket (out of scope) and never calls the service', async () => {
    dbSelectMock.mockResolvedValueOnce([]); // getScopedTicketOr404: no row

    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Updated subject' })
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Ticket not found');
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('returns the updated ticket from the service when it is in scope', async () => {
    dbSelectMock.mockResolvedValueOnce([STUB_TICKET]); // scoped pre-check
    serviceMocks.updateTicketFields.mockResolvedValue({ ...STUB_TICKET, subject: 'Updated subject' });

    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Updated subject' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ subject: 'Updated subject' });

    expect(serviceMocks.updateTicketFields).toHaveBeenCalledWith(
      TICKET_ID,
      expect.objectContaining({ subject: 'Updated subject' }),
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('400s on an empty body without calling the service', async () => {
    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'No fields to update');
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  describe('deviceId reassignment cross-org guard (enforced by the service)', () => {
    const DEVICE_ID = '9a8b7c6d-1111-4222-8333-444455556666';

    it('400s when the new deviceId belongs to a different org', async () => {
      dbSelectMock.mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1' }]); // scoped pre-check
      serviceMocks.updateTicketFields.mockRejectedValue(
        new TicketServiceError('Device must belong to the same organization as the ticket', 400)
      );

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/same organization/i);
    });

    it('404s when the new deviceId does not exist', async () => {
      dbSelectMock.mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1' }]);
      serviceMocks.updateTicketFields.mockRejectedValue(new TicketServiceError('Device not found', 404));

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Device not found');
    });

    it('404s when the scoped ticket lookup finds no row (out of scope)', async () => {
      dbSelectMock.mockResolvedValueOnce([]);

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty('error', 'Ticket not found');
      expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
    });

    it('updates when the new deviceId belongs to the ticket org', async () => {
      dbSelectMock.mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1' }]);
      serviceMocks.updateTicketFields.mockResolvedValue({ ...STUB_TICKET, deviceId: DEVICE_ID });

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toMatchObject({ deviceId: DEVICE_ID });
      expect(serviceMocks.updateTicketFields).toHaveBeenCalledWith(
        TICKET_ID,
        expect.objectContaining({ deviceId: DEVICE_ID }),
        expect.objectContaining({ userId: 'u-1' })
      );
    });

    it('clearing deviceId (null) passes the null through to the service', async () => {
      dbSelectMock.mockResolvedValueOnce([STUB_TICKET]);
      serviceMocks.updateTicketFields.mockResolvedValue({ ...STUB_TICKET, deviceId: null });

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: null })
      });
      expect(res.status).toBe(200);
      expect(serviceMocks.updateTicketFields).toHaveBeenCalledWith(
        TICKET_ID,
        expect.objectContaining({ deviceId: null }),
        expect.objectContaining({ userId: 'u-1' })
      );
    });
  });
});

describe('POST /tickets/bulk', () => {
  const T1 = 'aaaaaaaa-1111-4222-8333-444455556666';
  const T2 = 'bbbbbbbb-1111-4222-8333-444455556666';
  const ASSIGNEE_ID = '5a6b7c8d-1234-4321-abcd-000011112222';

  beforeEach(() => {
    vi.clearAllMocks();
    resetAuth();
    // Request-level pre-validation resolves the assignee once before the loop;
    // default to a same-partner user so per-test mocks stay focused.
    serviceMocks.getAssigneeForValidation.mockResolvedValue({ id: ASSIGNEE_ID, partnerId: 'p-1' });
  });

  const post = (body: unknown) =>
    makeApp().request('/tickets/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('bulk assign: scope-checks each id, calls assignTicket per ticket, aggregates and audits', async () => {
    dbSelectMock.mockResolvedValue([STUB_TICKET]); // every scoped lookup resolves
    serviceMocks.assignTicket.mockResolvedValue({ ...STUB_TICKET, assignedTo: ASSIGNEE_ID });

    const res = await post({ ticketIds: [T1, T2], action: 'assign', assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ updated: 2, skipped: 0, failed: 0, skippedReasons: {}, total: 2 });

    expect(serviceMocks.assignTicket).toHaveBeenCalledTimes(2);
    expect(serviceMocks.assignTicket).toHaveBeenCalledWith(T1, ASSIGNEE_ID, expect.objectContaining({ userId: 'u-1' }));
    expect(serviceMocks.assignTicket).toHaveBeenCalledWith(T2, ASSIGNEE_ID, expect.objectContaining({ userId: 'u-1' }));

    // One bulk-level audit entry (mirrors alerts bulk), on top of per-ticket service audits.
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ticket.bulk_assign',
        resourceType: 'ticket',
        details: expect.objectContaining({ ticketIds: [T1, T2], updated: 2, skipped: 0 })
      })
    );
  });

  it('bulk assign with null assigneeId (unassign) passes null to the service', async () => {
    dbSelectMock.mockResolvedValue([STUB_TICKET]);
    serviceMocks.assignTicket.mockResolvedValue({ ...STUB_TICKET, assignedTo: null });

    const res = await post({ ticketIds: [T1], action: 'assign', assigneeId: null });
    expect(res.status).toBe(200);
    expect(serviceMocks.assignTicket).toHaveBeenCalledWith(T1, null, expect.objectContaining({ userId: 'u-1' }));
  });

  it('bulk status: an FSM-invalid transition counts as skipped, not failed, and does not abort the loop', async () => {
    dbSelectMock.mockResolvedValue([STUB_TICKET]);
    serviceMocks.changeTicketStatus
      .mockResolvedValueOnce({ ...STUB_TICKET, status: 'pending' })
      .mockRejectedValueOnce(new TicketServiceError('Cannot transition ticket from closed to pending', 409, 'INVALID_TRANSITION'));

    const res = await post({ ticketIds: [T1, T2], action: 'status', status: 'pending' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ updated: 1, skipped: 1, failed: 0, skippedReasons: { INVALID_TRANSITION: 1 }, total: 2 });
    expect(serviceMocks.changeTicketStatus).toHaveBeenCalledTimes(2);
  });

  it('unexpected per-id errors count as failed without aborting the loop', async () => {
    dbSelectMock.mockResolvedValue([STUB_TICKET]);
    serviceMocks.changeTicketStatus
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ ...STUB_TICKET, status: 'closed' });

    const res = await post({ ticketIds: [T1, T2], action: 'status', status: 'closed' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ updated: 1, skipped: 0, failed: 1, skippedReasons: {}, total: 2 });
  });

  it('rejects status=resolved with 400 (resolution note is per-ticket) without calling the service', async () => {
    const res = await post({ ticketIds: [T1], action: 'status', status: 'resolved' });
    expect(res.status).toBe(400);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });

  it('out-of-scope ids count as skipped and never reach the service or the audit log', async () => {
    dbSelectMock.mockResolvedValue([]); // scoped lookup finds nothing
    const res = await post({ ticketIds: [T1], action: 'assign', assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ updated: 0, skipped: 1, failed: 0, skippedReasons: { OUT_OF_SCOPE: 1 }, total: 1 });
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown assignee with a request-level 400 before touching any ticket', async () => {
    serviceMocks.getAssigneeForValidation.mockResolvedValue(null);
    const res = await post({ ticketIds: [T1, T2], action: 'assign', assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', 'Assignee not found');
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-partner assignee with a request-level 400 for partner-scope callers', async () => {
    serviceMocks.getAssigneeForValidation.mockResolvedValue({ id: ASSIGNEE_ID, partnerId: 'p-OTHER' });
    const res = await post({ ticketIds: [T1], action: 'assign', assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', 'Assignee must belong to the same partner as the ticket');
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });

  it('skips assignee pre-validation when unassigning (null assigneeId)', async () => {
    dbSelectMock.mockResolvedValue([STUB_TICKET]);
    serviceMocks.assignTicket.mockResolvedValue({ ...STUB_TICKET, assignedTo: null });
    const res = await post({ ticketIds: [T1], action: 'assign', assigneeId: null });
    expect(res.status).toBe(200);
    expect(serviceMocks.getAssigneeForValidation).not.toHaveBeenCalled();
  });

  it('400s on an empty ticketIds array', async () => {
    const res = await post({ ticketIds: [], action: 'assign', assigneeId: ASSIGNEE_ID });
    expect(res.status).toBe(400);
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });

  it('400s when action=assign omits assigneeId (refine)', async () => {
    const res = await post({ ticketIds: [T1], action: 'assign' });
    expect(res.status).toBe(400);
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });
});

describe('site-axis scoping — per-ticket routes', () => {
  const SITE_AUTH = {
    ...DEFAULT_AUTH,
    scope: 'organization' as string,
    orgId: 'org-1' as string | null,
    partnerId: null as string | null,
    allowedSiteIds: ['site-1']
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = SITE_AUTH as typeof authRef.current;
  });

  it('GET /tickets/:id returns 404 for a ticket whose device is outside the caller sites', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(404);
  });

  it('GET /tickets/:id returns 404 when the ticket device has no site (restricted caller)', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: null }]);                                    // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(404);
  });

  it('GET /tickets/:id keeps deviceless tickets visible to site-restricted callers', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: null }]) // ticket fetch
      .mockResolvedValueOnce([{ orgName: 'Org', deviceHostname: null, assigneeName: null }]) // decoration
      .mockResolvedValueOnce([]); // alert links
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
  });

  it('POST /tickets/:id/assign is blocked (404) for an out-of-site ticket', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeId: null })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });

  it('GET /tickets/:id returns 404 for a device-bound ticket when the allowlist is empty', async () => {
    authRef.current = { ...SITE_AUTH, allowedSiteIds: [] } as typeof authRef.current;
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-1' }]);                                // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(404);
  });

  it('unrestricted callers (no allowedSiteIds) skip the device lookup entirely', async () => {
    authRef.current = { ...DEFAULT_AUTH } as typeof authRef.current; // partner scope, unrestricted
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, deviceId: 'd-1' }])                                  // ticket fetch
      .mockResolvedValueOnce([{ orgName: 'Org', deviceHostname: 'host', assigneeName: null }])       // decoration
      .mockResolvedValueOnce([]);                                                                     // alert links
    const res = await makeApp().request(`/tickets/${TICKET_ID}`);
    expect(res.status).toBe(200);
  });

  // The remaining per-ticket routes all resolve through getScopedTicketOr404 —
  // these pin the BINDING (a refactor inlining any route's ticket fetch would
  // silently drop the site gate; nothing else in the tree fails when that
  // happens because these handlers don't query device tables directly).
  it('POST /tickets/:id/status is blocked (404) for an out-of-site ticket', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });

  it('POST /tickets/:id/comments is blocked (404) for an out-of-site ticket', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(`/tickets/${TICKET_ID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'should not land', isPublic: false })
    });
    expect(res.status).toBe(404);
    expect(serviceMocks.addTicketComment).not.toHaveBeenCalled();
  });

  it('DELETE /tickets/:id/alerts/:alertId is blocked (404) for an out-of-site ticket', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request(
      `/tickets/${TICKET_ID}/alerts/9a8b7c6d-2222-4333-8444-555566667777`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
    expect(serviceMocks.unlinkAlertFromTicket).not.toHaveBeenCalled();
  });

  it('POST /tickets/bulk counts an out-of-site ticket as skipped (OUT_OF_SCOPE)', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                            // device fetch
    const res = await makeApp().request('/tickets/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketIds: [TICKET_ID], action: 'status', status: 'open' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ updated: 0, skipped: 1, failed: 0, skippedReasons: { OUT_OF_SCOPE: 1 }, total: 1 });
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });
});

describe('ticketSiteScopeCondition — tri-state contract', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const authWith = (allowedSiteIds?: string[]) =>
    ({ ...DEFAULT_AUTH, scope: 'organization', orgId: 'org-1', allowedSiteIds }) as never;

  it('returns undefined for unrestricted callers and builds no subquery', async () => {
    const { ticketSiteScopeCondition } = await import('./tickets');
    const { db } = await import('../../db');
    expect(ticketSiteScopeCondition(authWith(undefined))).toBeUndefined();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('returns a deviceless-only condition (no devices subquery) for an empty allowlist', async () => {
    const { ticketSiteScopeCondition } = await import('./tickets');
    const { db } = await import('../../db');
    const cond = ticketSiteScopeCondition(authWith([]));
    // A falsy-check regression (treating [] like undefined = unrestricted)
    // would return undefined here and let a zero-site user list everything.
    expect(cond).toBeDefined();
    // ...and the deviceless-only branch never consults devices.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('builds the devices IN-subquery for a populated allowlist', async () => {
    const { ticketSiteScopeCondition } = await import('./tickets');
    const { db } = await import('../../db');
    const cond = ticketSiteScopeCondition(authWith(['site-1', 'site-2']));
    expect(cond).toBeDefined();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1); // the subquery
  });
});

describe('site-axis scoping — list and stats', () => {
  const SITE_AUTH = {
    ...DEFAULT_AUTH,
    scope: 'organization' as string,
    orgId: 'org-1' as string | null,
    partnerId: null as string | null,
    allowedSiteIds: ['site-1']
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = SITE_AUTH as typeof authRef.current;
  });

  it('GET /tickets returns 403 when filtering by an out-of-site deviceId', async () => {
    dbSelectMock.mockResolvedValueOnce([{ siteId: 'site-OTHER' }]); // device lookup
    const res = await makeApp().request('/tickets?deviceId=9a8b7c6d-2222-4333-8444-555566667777');
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty('error', 'Device not found or access denied');
  });

  it('GET /tickets returns 403 when filtering by a nonexistent deviceId', async () => {
    dbSelectMock.mockResolvedValueOnce([]); // device lookup
    const res = await makeApp().request('/tickets?deviceId=9a8b7c6d-2222-4333-8444-555566667777');
    expect(res.status).toBe(403);
  });

  it('GET /tickets succeeds for a site-restricted caller (condition applied, no crash)', async () => {
    dbSelectMock.mockResolvedValue([]); // list rows (subquery is built, never executed)
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it('GET /tickets/stats succeeds for a site-restricted caller', async () => {
    dbGroupByMock.mockResolvedValue([
      { status: 'open', assignedTo: 'u-1', breached: false, count: 2 }
    ]);
    const res = await makeApp().request('/tickets/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ open: 2, mine: 2 });
  });
});

describe('site-axis scoping — write guards', () => {
  const SITE_AUTH = {
    ...DEFAULT_AUTH,
    scope: 'organization' as string,
    orgId: 'org-1' as string | null,
    partnerId: null as string | null,
    allowedSiteIds: ['site-1']
  };
  const DEVICE_ID = '9a8b7c6d-2222-4333-8444-555566667777';

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = SITE_AUTH as typeof authRef.current;
  });

  it('POST /tickets returns 403 for a deviceId outside the caller sites', async () => {
    dbSelectMock.mockResolvedValueOnce([{ siteId: 'site-OTHER' }]); // device lookup
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'x', deviceId: DEVICE_ID })
    });
    expect(res.status).toBe(403);
    expect(serviceMocks.createTicket).not.toHaveBeenCalled();
  });

  it('POST /tickets allows a deviceless create for a site-restricted caller', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', orgId: ORG_ID, internalNumber: 'T-2026-0042' });
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, subject: 'x' })
    });
    expect(res.status).toBe(201);
  });

  it('PATCH /tickets/:id returns 403 when moving a ticket onto an out-of-site device', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: null }]) // ticket fetch (in scope: deviceless)
      .mockResolvedValueOnce([{ siteId: 'site-OTHER' }]);                           // new device lookup
    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID })
    });
    expect(res.status).toBe(403);
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('PATCH /tickets/:id allows clearing the device (null) without a new-device lookup', async () => {
    dbSelectMock
      .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1', deviceId: 'd-1' }]) // ticket fetch
      .mockResolvedValueOnce([{ siteId: 'site-1' }]);                                // existing device gate (Task 5)
    serviceMocks.updateTicketFields.mockResolvedValue({ ...STUB_TICKET, deviceId: null });
    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: null })
    });
    expect(res.status).toBe(200);
  });
});

// Regression: Phase 1a shipped these routes WITHOUT authMiddleware in the chain,
// so over real HTTP every request 401'd ("Not authenticated") — requireScope
// found no c.get('auth'). The old test mock had requireScope inject the auth
// context itself, masking the missing middleware. This block proves the
// middleware is actually wired: it must run (call count) and must be the thing
// that rejects unauthenticated requests.
describe('authMiddleware wiring', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('GET /tickets returns 401 Not authenticated when unauthenticated, via authMiddleware', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Not authenticated');

    // The middleware itself must be in the chain (not some other 401 source)
    const { authMiddleware } = await import('../../middleware/auth');
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });

  it('authMiddleware runs on authenticated requests too', async () => {
    dbSelectMock.mockResolvedValue([]);
    const res = await makeApp().request('/tickets');
    expect(res.status).toBe(200);
    const { authMiddleware } = await import('../../middleware/auth');
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });
});
