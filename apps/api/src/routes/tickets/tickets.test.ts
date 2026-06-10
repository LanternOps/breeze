import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { serviceMocks, dbSelectMock, dbGroupByMock, authRef, lastWhereArgs } = vi.hoisted(() => {
  const lastWhereArgs: { conditions: unknown[] }[] = [];
  return {
    serviceMocks: {
      createTicket: vi.fn(),
      changeTicketStatus: vi.fn(),
      assignTicket: vi.fn(),
      addTicketComment: vi.fn(),
      linkAlertToTicket: vi.fn(),
      unlinkAlertFromTicket: vi.fn(),
    },
    dbSelectMock: vi.fn(),
    dbGroupByMock: vi.fn(),
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

vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

vi.mock('../../db', () => ({
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
  devices: { id: 'id', hostname: 'hostname', orgId: 'orgId' },
  organizations: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' }
}));

import { ticketsRoutes } from './tickets';

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

describe('PATCH /tickets/:id — scoped update', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns 404 when the scoped UPDATE returns no rows (ticket out of scope)', async () => {
    // PATCH goes directly to db.update(); returning empty array = out-of-scope / missing
    const { db } = await import('../../db');
    (db.update as any).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
      }))
    });

    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Updated subject' })
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Ticket not found');
  });

  it('returns the updated ticket when it is in scope', async () => {
    const updatedTicket = { ...STUB_TICKET, subject: 'Updated subject' };
    const { db } = await import('../../db');
    (db.update as any).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([updatedTicket])) }))
      }))
    });

    const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Updated subject' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ subject: 'Updated subject' });
  });

  describe('deviceId reassignment cross-org guard', () => {
    const DEVICE_ID = '9a8b7c6d-1111-4222-8333-444455556666';

    it('400s when the new deviceId belongs to a different org', async () => {
      // selects in order: scoped ticket lookup, device lookup
      dbSelectMock
        .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1' }])
        .mockResolvedValueOnce([{ id: DEVICE_ID, orgId: 'org-OTHER' }]);

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
      dbSelectMock
        .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1' }])
        .mockResolvedValueOnce([]); // device lookup: no row

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
    });

    it('updates when the new deviceId belongs to the ticket org', async () => {
      dbSelectMock
        .mockResolvedValueOnce([{ ...STUB_TICKET, orgId: 'org-1' }])
        .mockResolvedValueOnce([{ id: DEVICE_ID, orgId: 'org-1' }]);
      const updatedTicket = { ...STUB_TICKET, deviceId: DEVICE_ID };
      const { db } = await import('../../db');
      (db.update as any).mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([updatedTicket])) }))
        }))
      });

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toMatchObject({ deviceId: DEVICE_ID });
    });

    it('clearing deviceId (null) skips the device lookup and updates directly', async () => {
      const updatedTicket = { ...STUB_TICKET, deviceId: null };
      const { db } = await import('../../db');
      (db.update as any).mockReturnValue({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([updatedTicket])) }))
        }))
      });

      const res = await makeApp().request(`/tickets/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: null })
      });
      expect(res.status).toBe(200);
      // No scoped-ticket/device selects were consumed
      expect(dbSelectMock).not.toHaveBeenCalled();
    });
  });
});
