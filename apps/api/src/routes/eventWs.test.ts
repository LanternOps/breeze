import { beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------
// Mocks — must be declared before any import that triggers the modules
// -------------------------------------------------------------------

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => null),
  resolveRedisUrl: vi.fn(() => 'redis://localhost:6379'),
}));

const schemaTables = vi.hoisted(() => ({
  users: { table: 'users' },
  organizationUsers: { table: 'organizationUsers' },
  partnerUsers: { table: 'partnerUsers' },
  organizations: { table: 'organizations' },
}));

type LiveUserRow = {
  status: string;
  permissionsEpoch: number;
  partnerId: string;
  orgId: string | null;
};

let userStatusRow: LiveUserRow | undefined = {
  status: 'active',
  permissionsEpoch: 7,
  partnerId: 'partner-1',
  orgId: 'org-1',
};
let organizationMembershipRow:
  | { roleId: string; siteIds: string[] | null }
  | undefined = { roleId: 'org-role-1', siteIds: null };
let partnerMembershipRow:
  | { roleId: string; orgAccess: 'all' | 'selected' | 'none'; orgIds: string[] | null }
  | undefined = { roleId: 'partner-role-1', orgAccess: 'all', orgIds: null };
let partnerOrganizationRows: Array<{ id: string }> = [
  { id: 'org-1' },
  { id: 'org-2' },
  { id: 'org-3' },
];

function setUserStatusRow(row: Partial<LiveUserRow> | undefined) {
  userStatusRow = row
    ? {
        status: 'active',
        permissionsEpoch: 7,
        partnerId: 'partner-1',
        orgId: 'org-1',
        ...row,
      }
    : undefined;
}
function setOrganizationMembership(
  row: { roleId: string; siteIds: string[] | null } | undefined,
) {
  organizationMembershipRow = row;
}
function setPartnerMembership(
  row:
    | { roleId: string; orgAccess: 'all' | 'selected' | 'none'; orgIds: string[] | null }
    | undefined,
) {
  partnerMembershipRow = row;
}
let throwOnSelect = false;
function setThrowOnSelect(v: boolean) {
  throwOnSelect = v;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (throwOnSelect) throw new Error('db down');
            if (table === schemaTables.users) return userStatusRow ? [userStatusRow] : [];
            if (table === schemaTables.organizationUsers) {
              return organizationMembershipRow ? [organizationMembershipRow] : [];
            }
            if (table === schemaTables.partnerUsers) {
              return partnerMembershipRow ? [partnerMembershipRow] : [];
            }
            if (table === schemaTables.organizations) return partnerOrganizationRows;
            return [];
          }),
        })),
      })),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  ...schemaTables,
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
  resolveLiveEventAuthorization,
  createEventWsHandlers,
  _clearTicketStore,
  _storeLegacyTicketForTests,
} from './eventWs';
import { parseEventPermissionEpochMode } from '../config/env';

// -------------------------------------------------------------------
// Setup
// -------------------------------------------------------------------

beforeEach(() => {
  _clearTicketStore();
  vi.clearAllMocks();
  setUserStatusRow({ status: 'active', permissionsEpoch: 7 });
  setOrganizationMembership({ roleId: 'org-role-1', siteIds: null });
  setPartnerMembership({ roleId: 'partner-role-1', orgAccess: 'all', orgIds: null });
  partnerOrganizationRows = [{ id: 'org-1' }, { id: 'org-2' }, { id: 'org-3' }];
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
    const handlers = createEventWsHandlers(ticket, { jitterMs: () => 0 });
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

  it('retries one failed DB check shortly, then closes on the second failure', async () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      await openConnection(ws);

      setThrowOnSelect(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ws.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(ws.close).toHaveBeenCalledWith(4003, 'Access revoked');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['permission epoch mismatch', () => setUserStatusRow({ permissionsEpoch: 8 })],
    ['role change epoch bump', () => setUserStatusRow({ permissionsEpoch: 9 })],
    ['site change epoch bump', () => setUserStatusRow({ permissionsEpoch: 10 })],
    ['membership removal', () => setOrganizationMembership(undefined)],
  ])('closes when live authorization detects %s', async (_label, revoke) => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      await openConnection(ws);
      revoke();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(ws.close).toHaveBeenCalledWith(4003, 'Access revoked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not extend the DB close bound when Redis pub/sub is absent', async () => {
    const { getRedis } = await import('../services/redis');
    vi.mocked(getRedis).mockReturnValue(null);

    vi.useFakeTimers();
    try {
      const ws = makeWs();
      await openConnection(ws);
      setThrowOnSelect(true);

      await vi.advanceTimersByTimeAsync(35_000);

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
    setUserStatusRow({ orgId: null });
    const { ticket } = await createEventWsTicket('user-1', ['org-1', 'org-2', 'org-3']);
    const identity = await consumeTicket(ticket);
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-1',
      allowedOrgIds: ['org-1', 'org-2', 'org-3'],
      permissionsEpoch: 7,
    });
  });

  it('rejects an empty orgIds array', async () => {
    await expect(createEventWsTicket('user-1', [])).rejects.toThrow();
  });

  it('carries allowedSiteIds onto the consumed identity', async () => {
    setOrganizationMembership({ roleId: 'org-role-1', siteIds: ['site-a', 'site-b'] });
    const { ticket } = await createEventWsTicket('user-1', 'org-1', ['site-a', 'site-b']);
    const identity = await consumeTicket(ticket);
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-1',
      allowedOrgIds: ['org-1'],
      allowedSiteIds: ['site-a', 'site-b'],
      permissionsEpoch: 7,
    });
  });

  it('preserves an empty allowedSiteIds array as restricted-to-none', async () => {
    setOrganizationMembership({ roleId: 'org-role-1', siteIds: [] });
    const { ticket } = await createEventWsTicket('user-1', 'org-1', []);
    const identity = await consumeTicket(ticket);
    expect(identity?.allowedSiteIds).toEqual([]);
  });

  it('omits allowedSiteIds when not provided (unrestricted)', async () => {
    const { ticket } = await createEventWsTicket('user-1', 'org-1');
    const identity = await consumeTicket(ticket);
    expect(identity?.allowedSiteIds).toBeNull();
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
  });

  it('returns a deny-all filter for restricted-to-none', () => {
    const filter = buildSiteFilter([]);
    expect(filter).toBeTypeOf('function');
    expect(filter!({ type: 'device.online', payload: { siteId: 'site-a' } })).toBe(false);
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
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-1',
      allowedOrgIds: ['org-1'],
      permissionsEpoch: 7,
    });
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

describe('event ticket permission epoch compatibility', () => {
  it('mints a version-two ticket with the current permission epoch and authority axes', async () => {
    setUserStatusRow({
      status: 'active',
      permissionsEpoch: 41,
      partnerId: 'partner-1',
      orgId: 'org-1',
    });

    const { ticket } = await createEventWsTicket('user-1', 'org-1', null);
    const identity = await consumeTicket(ticket);

    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-1',
      partnerId: 'partner-1',
      orgId: 'org-1',
      allowedOrgIds: ['org-1'],
      allowedSiteIds: null,
      permissionsEpoch: 41,
    });
  });

  it('accepts a version-one ticket in compat only after fresh complete authorization resolution', async () => {
    setUserStatusRow({
      status: 'active',
      permissionsEpoch: 12,
      partnerId: 'partner-1',
      orgId: 'org-1',
    });
    setOrganizationMembership({ roleId: 'fresh-role', siteIds: ['fresh-site'] });
    const ticket = _storeLegacyTicketForTests({
      userId: 'user-1',
      orgIds: ['org-1'],
      allowedSiteIds: ['stale-site'],
      expiresAt: Date.now() + 30_000,
    });

    const identity = await consumeTicket(ticket, 'compat');

    expect(identity).toMatchObject({
      version: 2,
      permissionsEpoch: 12,
      allowedSiteIds: ['fresh-site'],
    });
    expect(identity?.allowedSiteIds).not.toContain('stale-site');
  });

  it('rejects a version-one ticket in enforce mode', async () => {
    const ticket = _storeLegacyTicketForTests({
      userId: 'user-1',
      orgIds: ['org-1'],
      expiresAt: Date.now() + 30_000,
    });

    await expect(consumeTicket(ticket, 'enforce')).resolves.toBeNull();
  });
});

describe('resolveLiveEventAuthorization', () => {
  async function mintIdentity(overrides?: {
    allowedSiteIds?: string[] | null;
    permissionsEpoch?: number;
  }) {
    setUserStatusRow({
      status: 'active',
      permissionsEpoch: overrides?.permissionsEpoch ?? 7,
      partnerId: 'partner-1',
      orgId: 'org-1',
    });
    const { ticket } = await createEventWsTicket(
      'user-1',
      'org-1',
      overrides?.allowedSiteIds ?? null,
    );
    return (await consumeTicket(ticket))!;
  }

  it('keeps a matching active membership authorized', async () => {
    setOrganizationMembership({ roleId: 'org-role-1', siteIds: ['site-a'] });
    const identity = await mintIdentity({ allowedSiteIds: ['site-a'] });

    await expect(resolveLiveEventAuthorization(identity)).resolves.toEqual({
      ok: true,
      identity,
    });
  });

  it.each([
    ['inactive user', { status: 'disabled' }, 'user_inactive'],
    ['permission epoch mismatch', { permissionsEpoch: 8 }, 'permission_epoch_mismatch'],
  ])('rejects %s', async (_label, userPatch, reason) => {
    const identity = await mintIdentity();
    setUserStatusRow(userPatch);

    await expect(resolveLiveEventAuthorization(identity)).resolves.toEqual({ ok: false, reason });
  });

  it('rejects removed membership', async () => {
    const identity = await mintIdentity();
    setOrganizationMembership(undefined);

    await expect(resolveLiveEventAuthorization(identity)).resolves.toEqual({
      ok: false,
      reason: 'membership_removed',
    });
  });

  it('rejects a site snapshot change even if an epoch trigger is temporarily unavailable', async () => {
    setOrganizationMembership({ roleId: 'org-role-1', siteIds: ['site-a'] });
    const identity = await mintIdentity({ allowedSiteIds: ['site-a'] });
    setOrganizationMembership({ roleId: 'org-role-1', siteIds: ['site-b'] });

    await expect(resolveLiveEventAuthorization(identity)).resolves.toEqual({
      ok: false,
      reason: 'permission_epoch_mismatch',
    });
  });

  it('reports an unavailable authoritative check without treating it as authorized', async () => {
    const identity = await mintIdentity();
    setThrowOnSelect(true);

    await expect(resolveLiveEventAuthorization(identity)).resolves.toEqual({
      ok: false,
      reason: 'live_state_unavailable',
    });
  });
});

describe('EVENT_PERMISSION_EPOCH_MODE validation', () => {
  it('defaults to compat only outside strict environments', () => {
    expect(parseEventPermissionEpochMode(undefined, 'test')).toBe('compat');
  });

  it.each(['production', 'staging'])('requires an explicit value in %s', (nodeEnv) => {
    expect(() => parseEventPermissionEpochMode(undefined, nodeEnv)).toThrow(
      'EVENT_PERMISSION_EPOCH_MODE is required',
    );
  });

  it('accepts compat and enforce and rejects every other value', () => {
    expect(parseEventPermissionEpochMode('compat', 'production')).toBe('compat');
    expect(parseEventPermissionEpochMode('enforce', 'production')).toBe('enforce');
    expect(() => parseEventPermissionEpochMode('unknown', 'test')).toThrow(
      'EVENT_PERMISSION_EPOCH_MODE must be compat or enforce',
    );
  });
});

// -------------------------------------------------------------------
// Tests: POST /ws-ticket route
// -------------------------------------------------------------------

describe('createEventWsTicketRoute', () => {
  it('returns a ticket when auth context is set', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    setUserStatusRow({ orgId: 'org-xyz' });

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
    setUserStatusRow({ orgId: null });
    partnerOrganizationRows = [{ id: 'org-from-query' }];

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
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-from-query'],
    });
  });

  it('issues a multi-org ticket for partner users when allOrgs=1', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    setUserStatusRow({ orgId: null });
    partnerOrganizationRows = [{ id: 'org-a' }, { id: 'org-b' }];

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
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-a', 'org-b'],
    });
  });

  // Regression guard (#2256): the All-Organizations Devices view opens the
  // event stream WITHOUT `orgId` or `allOrgs=1`. A partner user with multiple
  // accessible orgs must get a ticket scoped to ALL of them — the old
  // behaviour silently narrowed to `orgIds[0]`, so live device.online/offline
  // events for every other org were never delivered until a manual refresh.
  it('issues a multi-org ticket for partner users by default (no orgId, no allOrgs) — #2256', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    setUserStatusRow({ orgId: null });
    partnerOrganizationRows = [{ id: 'org-a' }, { id: 'org-b' }, { id: 'org-c' }];

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: null,
        scope: 'partner',
        partnerId: 'partner-1',
        canAccessOrg: () => true,
        accessibleOrgIds: ['org-a', 'org-b', 'org-c'],
      } as any);
      await next();
    });

    const { resolveOrgAccess } = await import('../middleware/auth');
    vi.mocked(resolveOrgAccess).mockResolvedValueOnce({
      type: 'multiple',
      orgIds: ['org-a', 'org-b', 'org-c'],
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    // No orgId, no allOrgs — exactly what useEventStream sends.
    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    const identity = await consumeTicket(body.ticket);
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-a', 'org-b', 'org-c'],
    });
  });

  // Branch-order guard: the `auth.orgId` short-circuit is the route-level
  // defense ensuring an ORG-scoped token can never mint a multi-org ticket
  // (org tokens carry a partnerId, and the 'multiple' branch is now strictly
  // broader with no opt-in flag). Even if resolveOrgAccess were to return
  // 'multiple', the ticket must stay scoped to the token's own org.
  it('org-token users get a single-org ticket even when orgAccess resolves to multiple', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    setUserStatusRow({ orgId: 'org-x' });

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: 'org-x',
        scope: 'organization',
        partnerId: 'partner-1',
      } as any);
      await next();
    });

    const { resolveOrgAccess } = await import('../middleware/auth');
    vi.mocked(resolveOrgAccess).mockResolvedValueOnce({
      type: 'multiple',
      orgIds: ['org-x', 'org-y'],
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    const identity = await consumeTicket(body.ticket);
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-x'],
    });
  });

  // A partner user with zero accessible orgs (just-onboarded partner) must get
  // the intended 400, not a 500 from createEventWsTicket's empty-array throw.
  it('returns 400 (not 500) for a partner user with zero accessible orgs', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();

    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-abc', email: 'a@b.com', name: 'A' },
        orgId: null,
        scope: 'partner',
        partnerId: 'partner-1',
        canAccessOrg: () => false,
        accessibleOrgIds: [],
      } as any);
      await next();
    });

    const { resolveOrgAccess } = await import('../middleware/auth');
    vi.mocked(resolveOrgAccess).mockResolvedValueOnce({ type: 'multiple', orgIds: [] });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('issued ticket is consumable with correct identity', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    setUserStatusRow({ orgId: 'org-xyz' });

    app.use('*', async (c, next) => {
      c.set('auth', { user: { id: 'user-abc', email: 'a@b.com', name: 'A' }, orgId: 'org-xyz' } as any);
      await next();
    });

    const ticketApp = createEventWsTicketRoute();
    app.route('/events', ticketApp);

    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    const body = await res.json();

    const identity = await consumeTicket(body.ticket);
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-xyz'],
    });
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
    setUserStatusRow({ orgId: 'org-xyz' });
    setOrganizationMembership({ roleId: 'org-role-1', siteIds: ['site-a'] });

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
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-xyz'],
      allowedSiteIds: ['site-a'],
    });
  });

  it('mints an unrestricted ticket when the identity carries no allowedSiteIds', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    setUserStatusRow({ orgId: 'org-xyz' });

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
    expect(identity).toMatchObject({
      version: 2,
      userId: 'user-abc',
      allowedOrgIds: ['org-xyz'],
      allowedSiteIds: null,
    });
  });
});
