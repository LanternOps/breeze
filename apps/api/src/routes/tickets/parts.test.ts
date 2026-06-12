import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbSelectMock, authRef, getScopedTicketOr404Mock, timeServiceMocks } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
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
  },
  getScopedTicketOr404Mock: vi.fn(),
  timeServiceMocks: {
    addTicketPart: vi.fn(),
    updateTicketPart: vi.fn(),
    deleteTicketPart: vi.fn(),
    listTimeEntries: vi.fn(),
    getTicketBillingSummary: vi.fn(),
    listBillables: vi.fn()
  }
}));

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
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          // Support both: direct await (GET /:id/parts list) and .limit(1) (part lookup)
          const result = dbSelectMock() ?? [];
          return {
            limit: vi.fn(() => dbSelectMock() ?? []),
            then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject)
          };
        })
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
    source: 'source', slaBreachedAt: 'sla_breached_at', firstResponseAt: 'first_response_at',
    responseSlaMinutes: 'response_sla_minutes', resolutionSlaMinutes: 'resolution_sla_minutes',
    slaPausedAt: 'sla_paused_at', slaPausedMinutes: 'sla_paused_minutes',
    slaBreachReason: 'sla_breach_reason'
  },
  ticketComments: { ticketId: 'ticketId', deletedAt: 'deletedAt', createdAt: 'createdAt' },
  ticketCategories: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId', id: 'id', linkType: 'linkType' },
  alerts: { id: 'id', title: 'title', severity: 'severity', status: 'status', deviceId: 'deviceId' },
  devices: { id: 'id', hostname: 'hostname', orgId: 'orgId', siteId: 'siteId' },
  organizations: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' },
  timeEntries: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', userId: 'userId',
    startedAt: 'startedAt', endedAt: 'endedAt', durationMinutes: 'durationMinutes',
    description: 'description', isBillable: 'isBillable', billingStatus: 'billingStatus',
    hourlyRate: 'hourlyRate', isApproved: 'isApproved', addedBy: 'addedBy'
  },
  ticketParts: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', addedBy: 'addedBy',
    description: 'description', quantity: 'quantity', unitPrice: 'unitPrice',
    costBasis: 'costBasis', isBillable: 'isBillable', billingStatus: 'billingStatus',
    createdAt: 'createdAt', updatedAt: 'updatedAt'
  }
}));

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof import('./tickets')>('./tickets');
  return {
    ...actual,
    getScopedTicketOr404: getScopedTicketOr404Mock
  };
});

vi.mock('../../services/timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
  return { ...actual, ...timeServiceMocks };
});

import { ticketsRoutes } from './index';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const PART_ID   = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

function resetMocks() {
  vi.clearAllMocks();
  authRef.current = {
    scope: 'partner',
    user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    partnerId: 'p-1',
    orgId: null,
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: (_id: string) => true
  };
}

describe('parts routes', () => {
  beforeEach(resetMocks);

  it('404s when the ticket is out of scope (site gate via getScopedTicketOr404)', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'SSD', quantity: 1 })
    });
    expect(res.status).toBe(404);
    expect(timeServiceMocks.addTicketPart).not.toHaveBeenCalled();
  });

  it('creates a part on an in-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1', deviceId: null });
    timeServiceMocks.addTicketPart.mockResolvedValue({ id: PART_ID });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'SSD', quantity: 1, unitPrice: 120 })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toHaveProperty('id', PART_ID);
  });

  it('GET /:id/parts returns part list for in-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1', deviceId: null });
    dbSelectMock.mockResolvedValue([{ id: PART_ID, ticketId: TICKET_ID, description: 'SSD' }]);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/parts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /:id/parts 404s for out-of-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/parts`);
    expect(res.status).toBe(404);
  });

  it('PATCH /parts/:id resolves scope through the parent ticket', async () => {
    dbSelectMock.mockReturnValueOnce([{ id: PART_ID, ticketId: TICKET_ID }]);
    getScopedTicketOr404Mock.mockResolvedValue(null); // parent out of scope
    const res = await ticketsRoutes.request(`/parts/${PART_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 2 })
    });
    expect(res.status).toBe(404);
    expect(timeServiceMocks.updateTicketPart).not.toHaveBeenCalled();
  });

  it('PATCH /parts/:id updates a part on an in-scope ticket', async () => {
    dbSelectMock.mockReturnValueOnce([{ id: PART_ID, ticketId: TICKET_ID }]);
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1', deviceId: null });
    timeServiceMocks.updateTicketPart.mockResolvedValue({ id: PART_ID, quantity: '2' });
    const res = await ticketsRoutes.request(`/parts/${PART_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 2 })
    });
    expect(res.status).toBe(200);
    expect(timeServiceMocks.updateTicketPart).toHaveBeenCalled();
  });

  it('DELETE /parts/:id 404s for out-of-scope ticket', async () => {
    dbSelectMock.mockReturnValueOnce([{ id: PART_ID, ticketId: TICKET_ID }]);
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/parts/${PART_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(timeServiceMocks.deleteTicketPart).not.toHaveBeenCalled();
  });

  it('DELETE /parts/:id deletes a part on an in-scope ticket', async () => {
    dbSelectMock.mockReturnValueOnce([{ id: PART_ID, ticketId: TICKET_ID }]);
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1', deviceId: null });
    timeServiceMocks.deleteTicketPart.mockResolvedValue(undefined);
    const res = await ticketsRoutes.request(`/parts/${PART_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(timeServiceMocks.deleteTicketPart).toHaveBeenCalled();
  });

  it('GET /:id/time-entries 404s for out-of-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/time-entries`);
    expect(res.status).toBe(404);
  });

  it('GET /:id/time-entries returns entries for in-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1', deviceId: null });
    timeServiceMocks.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/time-entries`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total', 0);
  });

  it('GET /:id/billing-summary 404s for out-of-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/billing-summary`);
    expect(res.status).toBe(404);
  });

  it('GET /:id/billing-summary returns summary for in-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1', deviceId: null });
    timeServiceMocks.getTicketBillingSummary.mockResolvedValue({
      time: { totalMinutes: 60, billableMinutes: 60, billableAmount: '125.00' },
      parts: { partsCount: 1, billableTotal: '99.00' }
    });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/billing-summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.time.billableAmount).toBe('125.00');
  });
});

describe('GET /export/billables.csv', () => {
  beforeEach(resetMocks);

  it('returns CSV with headers and no cost_basis column', async () => {
    timeServiceMocks.listBillables.mockResolvedValue([
      {
        kind: 'time', date: new Date('2026-06-10T10:00:00Z'), orgName: 'Acme',
        ticketNumber: 'T-2026-0001', description: 'fix', technician: 'Tess',
        quantity: '0.50', rate: '125.00', amount: '62.50',
        billingStatus: 'not_billed', isApproved: true
      }
    ]);
    const res = await ticketsRoutes.request('/export/billables.csv?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const body = await res.text();
    const headerLine = body.split('\n')[0];
    expect(headerLine).toBe('type,date,organization,ticket,description,technician,quantity,rate,amount,billing_status,approved');
    expect(body).toContain('T-2026-0001');
    expect(body).not.toContain('cost');
  });

  it('rejects missing date params with 400', async () => {
    const res = await ticketsRoutes.request('/export/billables.csv');
    expect(res.status).toBe(400);
    expect(timeServiceMocks.listBillables).not.toHaveBeenCalled();
  });
});
