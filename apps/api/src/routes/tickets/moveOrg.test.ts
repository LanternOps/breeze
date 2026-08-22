import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authRef, permsRef, getScopedTicketOr404Mock, moveTicketOrgMock } = vi.hoisted(() => ({
  // Resolved permission set the real requirePermission middleware stores on the
  // context (middleware/auth.ts) — the route's invoices:write gate reads it.
  permsRef: { current: { permissions: [{ resource: '*', action: '*' }] } as { permissions: { resource: string; action: string }[] } },
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1', 'org-b'] as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  getScopedTicketOr404Mock: vi.fn(),
  moveTicketOrgMock: vi.fn(),
}));

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    c.set('permissions', permsRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof import('./tickets')>('./tickets');
  return {
    ...actual,
    getScopedTicketOr404: getScopedTicketOr404Mock,
  };
});

vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, moveTicketOrg: moveTicketOrgMock };
});

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  tickets: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', status: 'status',
    priority: 'priority', assignedTo: 'assignedTo', categoryId: 'categoryId',
    internalNumber: 'internalNumber', subject: 'subject', createdAt: 'createdAt',
    updatedAt: 'updatedAt', dueDate: 'dueDate', deviceId: 'deviceId',
    source: 'source',
  },
  ticketComments: { ticketId: 'ticketId', deletedAt: 'deletedAt', createdAt: 'createdAt' },
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId', id: 'id', linkType: 'linkType' },
  alerts: { id: 'id', title: 'title', severity: 'severity', status: 'status', deviceId: 'deviceId' },
  devices: { id: 'id', hostname: 'hostname', orgId: 'orgId', siteId: 'siteId' },
  organizations: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' },
  ticketStatuses: { id: 'id', name: 'name', color: 'color' },
  ticketCategories: {},
  ticketParts: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', addedBy: 'addedBy',
    description: 'description', quantity: 'quantity', unitPrice: 'unitPrice',
    costBasis: 'costBasis', isBillable: 'isBillable', billingStatus: 'billingStatus',
    createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  timeEntries: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', userId: 'userId', partnerId: 'partnerId',
    startedAt: 'startedAt', endedAt: 'endedAt', durationMinutes: 'durationMinutes',
    description: 'description', isBillable: 'isBillable', billingStatus: 'billingStatus',
    hourlyRate: 'hourlyRate', isApproved: 'isApproved', addedBy: 'addedBy', runningTimerId: 'runningTimerId'
  },
}));

import { ticketsRoutes } from './index';
import { TicketServiceError } from '../../services/ticketService';
import { TicketMoveCurrencyBlockedError } from '../../services/ticketMoveCurrencyGuard';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const ORG_B_ID  = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

const STUB_TICKET = {
  id: TICKET_ID,
  orgId: 'org-1',
  partnerId: 'p-1',
  deviceId: null,
  subject: 'Printer',
};

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function resetAuth() {
  vi.clearAllMocks();
  permsRef.current = { permissions: [{ resource: '*', action: '*' }] };
  authRef.current = {
    scope: 'partner',
    user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    partnerId: 'p-1',
    orgId: null,
    accessibleOrgIds: ['org-1', ORG_B_ID],
    orgCondition: () => undefined,
    canAccessOrg: (_id: string) => true,
  };
}

describe('POST /tickets/:id/move-org', () => {
  beforeEach(resetAuth);

  it('moves to a same-partner org and returns 200', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    moveTicketOrgMock.mockResolvedValue({ id: TICKET_ID, orgId: ORG_B_ID, deviceId: null });

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(moveTicketOrgMock).toHaveBeenCalledWith(
      TICKET_ID,
      ORG_B_ID,
      expect.objectContaining({ userId: 'u-1' }),
      { acceptCurrencyMismatch: false },
    );
  });

  it('404s when ticket is out of scope', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID }),
    });

    expect(res.status).toBe(404);
    expect(moveTicketOrgMock).not.toHaveBeenCalled();
  });

  it('403s when caller cannot access the target org', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    authRef.current = {
      ...authRef.current,
      canAccessOrg: (_id: string) => false,
    };

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID }),
    });

    expect(res.status).toBe(403);
    expect(moveTicketOrgMock).not.toHaveBeenCalled();
  });

  it('surfaces 400 on cross-partner move via handleServiceError', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    moveTicketOrgMock.mockRejectedValue(
      new TicketServiceError('Cross-partner moves require system scope', 400),
    );

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  // ── Multi-currency guard (#3776, Task 13) ──────────────────────────────────
  it('409s with code + details when the service blocks a cross-currency move', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 1, unbilledParts: 2, accepted: false, blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 1, parts: 2 }] };
    moveTicketOrgMock.mockRejectedValue(new TicketMoveCurrencyBlockedError('Cannot move: stranded money', details));

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Cannot move: stranded money',
      code: 'TICKET_MOVE_CURRENCY_BLOCKED',
      details,
    });
  });

  it('403s acceptCurrencyMismatch:true without invoices:write and never calls the service', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    permsRef.current = { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'organizations', action: 'write' }] };

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID, acceptCurrencyMismatch: true }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/invoices:write/);
    expect(moveTicketOrgMock).not.toHaveBeenCalled();
  });

  it('acceptCurrencyMismatch:false never needs invoices:write', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    permsRef.current = { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'organizations', action: 'write' }] };
    moveTicketOrgMock.mockResolvedValue({ id: TICKET_ID, orgId: ORG_B_ID, deviceId: null });

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID, acceptCurrencyMismatch: false }),
    });

    expect(res.status).toBe(200);
    expect(moveTicketOrgMock).toHaveBeenCalledWith(TICKET_ID, ORG_B_ID, expect.anything(), { acceptCurrencyMismatch: false });
  });

  it('passes acceptCurrencyMismatch:true through when the caller has invoices:write', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    permsRef.current = { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'organizations', action: 'write' }, { resource: 'invoices', action: 'write' }] };
    moveTicketOrgMock.mockResolvedValue({ id: TICKET_ID, orgId: ORG_B_ID, deviceId: null });

    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID, acceptCurrencyMismatch: true }),
    });

    expect(res.status).toBe(200);
    expect(moveTicketOrgMock).toHaveBeenCalledWith(TICKET_ID, ORG_B_ID, expect.anything(), { acceptCurrencyMismatch: true });
  });

  it('400s a non-boolean acceptCurrencyMismatch', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(STUB_TICKET);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/move-org`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ orgId: ORG_B_ID, acceptCurrencyMismatch: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(moveTicketOrgMock).not.toHaveBeenCalled();
  });
});
