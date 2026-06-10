import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { serviceMocks, dbSelectMock } = vi.hoisted(() => ({
  serviceMocks: {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn(),
    linkAlertToTicket: vi.fn(),
    unlinkAlertFromTicket: vi.fn(),
    createTicketFromAlert: vi.fn()
  },
  dbSelectMock: vi.fn()
}));

vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1',
      orgId: null,
      accessibleOrgIds: null,
      orgCondition: () => undefined,
      canAccessOrg: () => true
    });
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
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({ offset: vi.fn(() => dbSelectMock()) }))
                }))
              }))
            })),
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => dbSelectMock()) }))
              }))
            }))
          }))
        })),
        where: vi.fn(() => ({
          orderBy: vi.fn(() => Promise.resolve([])),
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
    source: 'source', slaBreachedAt: 'slaBreachedAt', firstResponseAt: 'firstResponseAt'
  },
  ticketComments: { ticketId: 'ticketId', deletedAt: 'deletedAt', createdAt: 'createdAt' },
  ticketCategories: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId', id: 'id', linkType: 'linkType' },
  alerts: { id: 'id', title: 'title', severity: 'severity', status: 'status' },
  devices: { id: 'id', hostname: 'hostname' },
  organizations: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' }
}));

import { ticketsRoutes } from './tickets';

function makeApp() {
  const app = new Hono();
  app.route('/tickets', ticketsRoutes);
  return app;
}

describe('GET /tickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns paginated data', async () => {
    dbSelectMock.mockResolvedValue([{ id: 't-1', internalNumber: 'T-2026-0001', subject: 'Printer' }]);
    const res = await makeApp().request('/tickets?statusGroup=open');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
  });

  it('rejects an invalid statusGroup', async () => {
    const res = await makeApp().request('/tickets?statusGroup=weird');
    expect(res.status).toBe(400);
  });
});

describe('POST /tickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates via ticketService and returns 201', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', internalNumber: 'T-2026-0001' });
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: 'Printer offline' })
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
      body: JSON.stringify({ orgId: '3f2f1d8e-1111-4222-8333-444455556666' })
    });
    expect(res.status).toBe(400);
  });

  it('maps TicketServiceError status through (404 org)', async () => {
    const { TicketServiceError } = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
    serviceMocks.createTicket.mockRejectedValue(new TicketServiceError('Organization not found', 404));
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: 'x' })
    });
    expect(res.status).toBe(404);
  });
});
