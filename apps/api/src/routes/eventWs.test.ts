import { beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules
// -------------------------------------------------------------------

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => null),
  resolveRedisUrl: vi.fn(() => 'redis://localhost:6379'),
}));

vi.mock('../services/eventDispatcher', () => {
  const register = vi.fn();
  const unregister = vi.fn();
  return {
    getEventDispatcher: vi.fn(() => ({ register, unregister })),
    matchesEventType: vi.fn(),
  };
});

// Mock auth middleware as a pass-through (tests inject auth context manually)
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => { await next(); }),
  resolveOrgAccess: vi.fn(async (auth: any, requestedOrgId?: string) => {
    if (requestedOrgId) return { type: 'single', orgId: requestedOrgId };
    if (auth.scope === 'partner' && auth.partnerId) return { type: 'multiple', orgIds: [] };
    if (auth.scope === 'organization' && auth.orgId) return { type: 'single', orgId: auth.orgId };
    return { type: 'all' };
  }),
}));

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------

import {
  createEventWsTicket,
  consumeTicket,
  createEventWsTicketRoute,
  _clearTicketStore,
} from './eventWs';

// -------------------------------------------------------------------
// Setup
// -------------------------------------------------------------------

beforeEach(() => {
  _clearTicketStore();
  vi.clearAllMocks();
});

// -------------------------------------------------------------------
// Tests: ticket creation & consumption
// -------------------------------------------------------------------

describe('createEventWsTicket', () => {
  it('returns a ticket and expiry in seconds', async () => {
    const result = await createEventWsTicket('user-1', 'org-1');
    expect(result.ticket).toBeTruthy();
    expect(typeof result.ticket).toBe('string');
    expect(result.ticket.length).toBeGreaterThan(20);
    expect(result.expiresInSeconds).toBe(30);
  });

  it('creates unique tickets on each call', async () => {
    const a = await createEventWsTicket('user-1', 'org-1');
    const b = await createEventWsTicket('user-1', 'org-1');
    expect(a.ticket).not.toBe(b.ticket);
  });
});

describe('consumeTicket', () => {
  it('returns identity for a valid ticket', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    const identity = await consumeTicket(ticket);
    expect(identity).toEqual({ userId: 'user-1', orgId: 'org-1' });
  });

  it('returns null on second consumption (one-time use)', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    await consumeTicket(ticket);
    const second = await consumeTicket(ticket);
    expect(second).toBeNull();
  });

  it('returns null for a non-existent ticket', async () => {
    const result = await consumeTicket('bogus-ticket');
    expect(result).toBeNull();
  });

  it('returns null for an expired ticket', async () => {
    // Manually inject an already-expired ticket
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    // Monkey-patch the store entry to be expired — access internals via the
    // clear helper pattern: create, then modify via Date.now override.
    // Simpler: create a ticket, advance time, then consume.
    vi.useFakeTimers();
    const { ticket: t2 } = await createEventWsTicket('user-2', 'org-2');
    vi.advanceTimersByTime(31_000); // past 30s TTL
    const result = await consumeTicket(t2);
    expect(result).toBeNull();
    vi.useRealTimers();
  });
});

// -------------------------------------------------------------------
// Tests: POST /ws-ticket route
// -------------------------------------------------------------------

describe('createEventWsTicketRoute', () => {
  it('returns a ticket when auth context is set', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    // Simulate auth middleware setting the auth context
    app.use('*', async (c, next) => {
      c.set('auth', { user: { id: 'user-abc', email: 'a@b.com', name: 'A' }, orgId: 'org-xyz' } as any);
      await next();
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ticket).toBeTruthy();
    expect(body.expiresInSeconds).toBe(30);
  });

  it('returns 401 when auth context is missing', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    // No auth middleware — auth not set
    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when orgId cannot be resolved', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', { user: { id: 'user-abc', email: 'a@b.com', name: 'A' }, orgId: null, scope: 'system' } as any);
      await next();
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('resolves orgId from query param for partner users', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: null,
        scope: 'partner',
        partnerId: 'partner-1',
        canAccessOrg: () => true,
        accessibleOrgIds: ['org-from-query'],
      } as any);
      await next();
    });

    const { resolveOrgAccess } = await import('../middleware/auth');
    vi.mocked(resolveOrgAccess).mockResolvedValueOnce({ type: 'single', orgId: 'org-from-query' });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket?orgId=org-from-query', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ticket).toBeTruthy();

    const identity = await consumeTicket(body.ticket);
    expect(identity).toEqual({ userId: 'user-abc', orgId: 'org-from-query' });
  });

  it('issued ticket is consumable with correct identity', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', { user: { id: 'user-abc', email: 'a@b.com', name: 'A' }, orgId: 'org-xyz' } as any);
      await next();
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    const body = await res.json();

    const identity = await consumeTicket(body.ticket);
    expect(identity).toEqual({ userId: 'user-abc', orgId: 'org-xyz' });
  });
});
