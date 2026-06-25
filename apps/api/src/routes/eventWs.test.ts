import { beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules
// -------------------------------------------------------------------

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => null),
  resolveRedisUrl: vi.fn(() => 'redis://localhost:6379'),
}));

// DB mock — `isEventWsUserActive` selects the user's status under system
// scope. Tests drive the returned row via `setUserStatusRow`.
let userStatusRow: { status: string } | undefined = { status: 'active' };
function setUserStatusRow(row: { status: string } | undefined) {
  userStatusRow = row;
}
let throwOnSelect = false;
function setThrowOnSelect(v: boolean) {
  throwOnSelect = v;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (throwOnSelect) throw new Error('db down');
            return userStatusRow ? [userStatusRow] : [];
          }),
        })),
      })),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  users: {},
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
  buildSiteFilter,
  isEventWsUserActive,
  createEventWsHandlers,
  _clearTicketStore,
} from './eventWs';

// -------------------------------------------------------------------
// Setup
// -------------------------------------------------------------------

beforeEach(() => {
  _clearTicketStore();
  vi.clearAllMocks();
  setUserStatusRow({ status: 'active' });
  setThrowOnSelect(false);
});

// -------------------------------------------------------------------
// Tests: mid-session user revalidation (revocation gap)
//
// The WS ticket snapshots the user's org access at consume time; the
// connection then delivers events indefinitely. `isEventWsUserActive` is the
// authoritative recheck used by the revalidation interval to tear the socket
// down once a user is deactivated/suspended/deleted. It must FAIL CLOSED.
// -------------------------------------------------------------------

describe('isEventWsUserActive', () => {
  it('returns true while the user is still active', async () => {
    setUserStatusRow({ status: 'active' });
    await expect(isEventWsUserActive('user-1')).resolves.toBe(true);
  });

  it('returns false when the user has been deactivated/suspended', async () => {
    setUserStatusRow({ status: 'suspended' });
    await expect(isEventWsUserActive('user-1')).resolves.toBe(false);
  });

  it('returns false when the user row no longer exists (deleted)', async () => {
    setUserStatusRow(undefined);
    await expect(isEventWsUserActive('user-1')).resolves.toBe(false);
  });
});

describe('event WS mid-session revocation (handler interval)', () => {
  function makeWs() {
    return {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    } as any;
  }

  async function openConnection(ws: any) {
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    const handlers = createEventWsHandlers(ticket);
    await handlers.onOpen(undefined, ws);
    return handlers;
  }

  it('closes the socket fail-closed once the user is revoked, and unregisters from the dispatcher (stops delivery)', async () => {
    const { getEventDispatcher } = await import('../services/eventDispatcher');
    const dispatcher = getEventDispatcher() as any;

    vi.useFakeTimers();
    try {
      const ws = makeWs();
      await openConnection(ws);

      // Registered for delivery on open.
      expect(dispatcher.register).toHaveBeenCalledWith('org-1', expect.anything());
      expect(ws.close).not.toHaveBeenCalled();

      // User is revoked mid-session.
      setUserStatusRow({ status: 'suspended' });

      // Advance to the revalidation tick and flush the async check.
      await vi.advanceTimersByTimeAsync(30_000);

      // Socket torn down fail-closed and delivery stopped (unregistered).
      expect(ws.close).toHaveBeenCalledWith(4003, 'Access revoked');
      expect(dispatcher.unregister).toHaveBeenCalledWith('org-1', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the revalidation DB check throws', async () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      await openConnection(ws);

      setThrowOnSelect(true);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(ws.close).toHaveBeenCalledWith(4003, 'Access revoked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a still-valid connection open and registered across revalidation ticks', async () => {
    const { getEventDispatcher } = await import('../services/eventDispatcher');
    const dispatcher = getEventDispatcher() as any;

    vi.useFakeTimers();
    try {
      const ws = makeWs();
      await openConnection(ws);

      // User stays active across multiple revalidation ticks.
      setUserStatusRow({ status: 'active' });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(ws.close).not.toHaveBeenCalled();
      expect(dispatcher.unregister).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the revalidation interval on close (no leak, no post-close revocation)', async () => {
    const { getEventDispatcher } = await import('../services/eventDispatcher');
    const dispatcher = getEventDispatcher() as any;

    vi.useFakeTimers();
    try {
      const ws = makeWs();
      const handlers = await openConnection(ws);

      await handlers.onClose(undefined, ws);
      expect(dispatcher.unregister).toHaveBeenCalledWith('org-1', expect.anything());

      // After close, a revoked user must not trigger another close() call —
      // the interval was cleared.
      setUserStatusRow({ status: 'suspended' });
      ws.close.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ws.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
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

  it('accepts an array of orgIds for multi-org partner tickets', async () => {
    const { ticket } = await createEventWsTicket('user-1', ['org-1', 'org-2', 'org-3']);
    const identity = await consumeTicket(ticket);
    expect(identity).toEqual({ userId: 'user-1', orgIds: ['org-1', 'org-2', 'org-3'] });
  });

  it('rejects an empty orgIds array', async () => {
    await expect(createEventWsTicket('user-1', [])).rejects.toThrow();
  });

  it('carries allowedSiteIds onto the consumed identity', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1', ['site-a', 'site-b']);
    const identity = await consumeTicket(ticket);
    expect(identity).toEqual({
      userId: 'user-1',
      orgIds: ['org-1'],
      allowedSiteIds: ['site-a', 'site-b'],
    });
  });

  it('treats an empty allowedSiteIds array as unrestricted (full org access)', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1', []);
    const identity = await consumeTicket(ticket);
    expect(identity).toEqual({ userId: 'user-1', orgIds: ['org-1'], allowedSiteIds: undefined });
  });

  it('omits allowedSiteIds when not provided (unrestricted)', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    const identity = await consumeTicket(ticket);
    expect(identity?.allowedSiteIds).toBeUndefined();
  });
});

// -------------------------------------------------------------------
// Tests: site-scope delivery predicate (Finding #8)
//
// A site-restricted client must NOT receive live events for devices/sites
// outside its allowlist. Events are delivered over Redis pub/sub with no DB
// backstop, so the WS layer is the only enforcement point.
// -------------------------------------------------------------------

describe('buildSiteFilter', () => {
  it('returns undefined for an unrestricted user (no allowlist)', () => {
    expect(buildSiteFilter(undefined)).toBeUndefined();
    expect(buildSiteFilter([])).toBeUndefined();
  });

  it('delivers an in-site event (siteId on payload)', () => {
    const filter = buildSiteFilter(['site-a']);
    expect(filter).toBeTypeOf('function');
    const event = { type: 'alert.triggered', payload: { deviceId: 'dev-1', siteId: 'site-a' } };
    expect(filter!(event)).toBe(true);
  });

  it('delivers an in-site event (siteId at top level)', () => {
    const filter = buildSiteFilter(['site-a']);
    const event = { type: 'device.offline', siteId: 'site-a', payload: { deviceId: 'dev-1' } };
    expect(filter!(event)).toBe(true);
  });

  it('drops an out-of-site event for a site-restricted client', () => {
    const filter = buildSiteFilter(['site-a']);
    const event = { type: 'alert.triggered', payload: { deviceId: 'dev-2', siteId: 'site-b' } };
    expect(filter!(event)).toBe(false);
  });

  it('fails closed: drops an event with no attributable siteId', () => {
    const filter = buildSiteFilter(['site-a']);
    // deviceId-only payload (the current real-world shape — publishers emit no
    // siteId), and a fully org-level event with no device context.
    expect(filter!({ type: 'alert.triggered', payload: { deviceId: 'dev-1' } })).toBe(false);
    expect(filter!({ type: 'incident.created', payload: { userId: 'user-9' } })).toBe(false);
    expect(filter!({ type: 'user.login' })).toBe(false);
  });

  it('matches any one of multiple allowed sites', () => {
    const filter = buildSiteFilter(['site-a', 'site-c']);
    expect(filter!({ type: 'device.online', payload: { siteId: 'site-c' } })).toBe(true);
    expect(filter!({ type: 'device.online', payload: { siteId: 'site-b' } })).toBe(false);
  });
});

// -------------------------------------------------------------------
// Tests: the filter built for a registered client enforces site scope
//
// Models how the dispatcher consults `client.filter` at send time: an
// in-site event is delivered, an out-of-site / unattributable event is
// dropped, and an unrestricted client (no filter) receives everything.
// (End-to-end dispatch wiring is covered in eventDispatcher.test.ts.)
// -------------------------------------------------------------------

describe('registered-client site filter enforcement', () => {
  // Mirrors EventDispatcher.dispatch(): subscription-type match AND, when a
  // per-client predicate is present, predicate match.
  function delivers(client: { subscribedTypes: Set<string>; filter?: (e: any) => boolean }, event: any): boolean {
    const matchesType = client.subscribedTypes.has('*') || client.subscribedTypes.has(event.type);
    if (!matchesType) return false;
    return client.filter ? client.filter(event) : true;
  }

  const inSite = { type: 'alert.triggered', payload: { deviceId: 'd1', siteId: 'site-a' } };
  const outOfSite = { type: 'alert.triggered', payload: { deviceId: 'd2', siteId: 'site-b' } };
  const noSite = { type: 'alert.triggered', payload: { deviceId: 'd3' } };

  it('site-restricted client receives in-site events only', () => {
    const client = { subscribedTypes: new Set(['*']), filter: buildSiteFilter(['site-a']) };
    expect(delivers(client, inSite)).toBe(true);
    expect(delivers(client, outOfSite)).toBe(false);
    expect(delivers(client, noSite)).toBe(false); // fail closed
  });

  it('unrestricted client receives all events', () => {
    const client = { subscribedTypes: new Set(['*']), filter: buildSiteFilter(undefined) };
    expect(client.filter).toBeUndefined();
    expect(delivers(client, inSite)).toBe(true);
    expect(delivers(client, outOfSite)).toBe(true);
    expect(delivers(client, noSite)).toBe(true);
  });
});

describe('consumeTicket', () => {
  it('returns identity for a valid ticket', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    const identity = await consumeTicket(ticket);
    expect(identity).toEqual({ userId: 'user-1', orgIds: ['org-1'] });
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
    expect(identity).toEqual({ userId: 'user-abc', orgIds: ['org-from-query'] });
  });

  it('issues a multi-org ticket for partner users when allOrgs=1', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: null,
        scope: 'partner',
        partnerId: 'partner-1',
        canAccessOrg: () => true,
        accessibleOrgIds: ['org-a', 'org-b'],
      } as any);
      await next();
    });

    const { resolveOrgAccess } = await import('../middleware/auth');
    vi.mocked(resolveOrgAccess).mockResolvedValueOnce({
      type: 'multiple',
      orgIds: ['org-a', 'org-b'],
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket?allOrgs=1', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    const identity = await consumeTicket(body.ticket);
    expect(identity).toEqual({ userId: 'user-abc', orgIds: ['org-a', 'org-b'] });
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
    expect(identity).toEqual({ userId: 'user-abc', orgIds: ['org-xyz'] });
  });

  // Regression guard (Finding #8): the SITE-scope restriction must be sourced
  // from the authenticated identity (`auth.allowedSiteIds`, set by
  // authMiddleware) and threaded into the minted ticket — NOT from
  // `c.get('permissions')`, which is only populated by `requirePermission` and
  // never runs on this route. This test exercises the real route handler end to
  // end (auth context → route → minted ticket → consumed identity), so it goes
  // red if the handler is reverted to read `permissions` (which would be
  // undefined here, dropping the restriction).
  it('threads allowedSiteIds from the authenticated identity into the minted ticket', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: 'org-xyz',
        // Site restriction lives on the auth identity (authMiddleware), not on
        // `permissions`. The route MUST read this field.
        allowedSiteIds: ['site-a'],
      } as any);
      // Defensive: even if `permissions` carried a different value, the route
      // must ignore it. A reverted handler reading `permissions.allowedSiteIds`
      // would pick up the wrong restriction and fail the assertion below.
      c.set('permissions', { allowedSiteIds: ['site-WRONG'] } as any);
      await next();
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    const identity = await consumeTicket(body.ticket);
    expect(identity).toEqual({
      userId: 'user-abc',
      orgIds: ['org-xyz'],
      allowedSiteIds: ['site-a'],
    });
  });

  it('mints an unrestricted ticket when the identity carries no allowedSiteIds', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: 'org-xyz',
        // No allowedSiteIds → unrestricted (full org access).
      } as any);
      await next();
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    const identity = await consumeTicket(body.ticket);
    expect(identity).toEqual({ userId: 'user-abc', orgIds: ['org-xyz'] });
    expect(identity?.allowedSiteIds).toBeUndefined();
  });
});
