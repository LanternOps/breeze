import { describe, it, expect, vi, afterEach } from 'vitest';
import { matchesEventType, getEventDispatcher, shutdownEventDispatcher } from './eventDispatcher';
import { buildSiteFilter } from '../routes/eventWs';

vi.mock('./redis', () => ({
  resolveRedisUrl: () => 'redis://localhost:6379',
  REDIS_CLIENT_BASE_OPTIONS: { protocol: 2 },
}));

// Tracks every MockRedis instance ever constructed, across the whole test
// file — used to assert how many actual Redis connections the dispatcher
// opened (the whole point of the fix under test: one shared connection, not
// one per org). Declared via vi.hoisted so it's initialized before the
// hoisted vi.mock('ioredis', ...) factory below (which is what actually
// needs it) runs.
const { MockRedis, mockRedisInstances } = vi.hoisted(() => {
  class MockRedisImpl {
    psubscribeMock = vi.fn((_pattern: string, cb: (err: Error | null, count?: number) => void) => cb(null, 1));
    punsubscribe = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue(undefined);
    handlers = new Map<string, (...args: unknown[]) => void>();

    constructor() {
      instances.push(this);
    }

    psubscribe(...args: Parameters<MockRedisImpl['psubscribeMock']>) {
      return this.psubscribeMock(...args);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
    }

    /** Simulate Redis delivering a message on a channel matching our pattern. */
    emitPmessage(channel: string, message: string) {
      this.handlers.get('pmessage')?.('breeze:events:live:*', channel, message);
    }
  }
  const instances: InstanceType<typeof MockRedisImpl>[] = [];
  return { MockRedis: MockRedisImpl, mockRedisInstances: instances };
});

vi.mock('ioredis', () => ({ default: MockRedis }));

describe('matchesEventType', () => {
  it('matches exact event type', () => {
    expect(matchesEventType('device.online', 'device.online')).toBe(true);
  });

  it('rejects non-matching exact type', () => {
    expect(matchesEventType('device.offline', 'device.online')).toBe(false);
  });

  it('matches wildcard prefix', () => {
    expect(matchesEventType('device.online', 'device.*')).toBe(true);
    expect(matchesEventType('device.offline', 'device.*')).toBe(true);
    expect(matchesEventType('device.updated', 'device.*')).toBe(true);
  });

  it('rejects wrong prefix with wildcard', () => {
    expect(matchesEventType('alert.triggered', 'device.*')).toBe(false);
  });

  it('matches global wildcard', () => {
    expect(matchesEventType('device.online', '*')).toBe(true);
    expect(matchesEventType('alert.triggered', '*')).toBe(true);
  });

  it('rejects invalid patterns', () => {
    expect(matchesEventType('device.online', '*.online')).toBe(false);
    expect(matchesEventType('device.online', 'device.**')).toBe(false);
  });
});

describe('EventDispatcher', () => {
  // Mock WSContext
  function mockWs() {
    return { send: vi.fn(), close: vi.fn() } as any;
  }

  afterEach(async () => {
    await shutdownEventDispatcher();
    mockRedisInstances.length = 0;
  });

  it('dispatches event only to the correct org (multi-tenant isolation)', () => {
    const dispatcher = getEventDispatcher();
    const ws1 = mockWs();
    const ws2 = mockWs();
    const client1 = { ws: ws1, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    const client2 = { ws: ws2, userId: 'user-2', subscribedTypes: new Set(['device.*']) };

    dispatcher.register('org-1', client1);
    dispatcher.register('org-2', client2);

    (dispatcher as any).dispatch('org-1', JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: {} }));

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).not.toHaveBeenCalled();

    dispatcher.unregister('org-1', client1);
    dispatcher.unregister('org-2', client2);
  });

  it('filters events by subscribed types', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    dispatcher.register('org-1', client);

    (dispatcher as any).dispatch('org-1', JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: {} }));
    expect(ws.send).toHaveBeenCalledTimes(1);

    ws.send.mockClear();
    (dispatcher as any).dispatch('org-1', JSON.stringify({ type: 'alert.triggered', orgId: 'org-1', payload: {} }));
    expect(ws.send).not.toHaveBeenCalled();

    dispatcher.unregister('org-1', client);
  });

  it('skips clients with empty subscribedTypes', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set<string>() };
    dispatcher.register('org-1', client);

    (dispatcher as any).dispatch('org-1', JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: {} }));
    expect(ws.send).not.toHaveBeenCalled();

    dispatcher.unregister('org-1', client);
  });

  it('handles malformed JSON without crashing', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    dispatcher.register('org-1', client);

    expect(() => (dispatcher as any).dispatch('org-1', 'not json')).not.toThrow();
    expect(ws.send).not.toHaveBeenCalled();

    dispatcher.unregister('org-1', client);
  });

  it('handles missing type field without crashing', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    dispatcher.register('org-1', client);

    (dispatcher as any).dispatch('org-1', JSON.stringify({ foo: 'bar' }));
    expect(ws.send).not.toHaveBeenCalled();

    dispatcher.unregister('org-1', client);
  });

  it('continues dispatching to other clients when one ws.send fails', () => {
    const dispatcher = getEventDispatcher();
    const ws1 = mockWs();
    const ws2 = mockWs();
    ws1.send.mockImplementation(() => { throw new Error('connection closed'); });
    const client1 = { ws: ws1, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    const client2 = { ws: ws2, userId: 'user-2', subscribedTypes: new Set(['device.*']) };
    dispatcher.register('org-1', client1);
    dispatcher.register('org-1', client2);

    (dispatcher as any).dispatch('org-1', JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: {} }));
    expect(ws2.send).toHaveBeenCalledTimes(1);

    dispatcher.unregister('org-1', client1);
    dispatcher.unregister('org-1', client2);
  });

  it('broadcasts alert.acknowledged with the publisher payload to subscribed clients', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set(['alert.*']) };
    dispatcher.register('org-1', client);

    const event = {
      id: 'evt-123',
      type: 'alert.acknowledged',
      orgId: 'org-1',
      source: 'alerts-route',
      priority: 'normal',
      payload: { alertId: 'a1', deviceId: 'd1', acknowledgedBy: 'u1' },
      metadata: { timestamp: '2026-05-07T00:00:00Z' },
    };

    (dispatcher as any).dispatch('org-1', JSON.stringify(event));

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('event');
    expect(sent.data.type).toBe('alert.acknowledged');
    expect(sent.data.payload).toEqual({ alertId: 'a1', deviceId: 'd1', acknowledgedBy: 'u1' });
    expect(sent.data.orgId).toBe('org-1');

    dispatcher.unregister('org-1', client);
  });

  // -------------------------------------------------------------------
  // Per-client `filter` predicate (site-scope authz hook).
  //
  // The dispatch loop consults `client.filter` after the subscription-type
  // match: deliver only when the predicate returns true, and FAIL CLOSED on
  // throw (drop the event for that client without crashing dispatch or
  // affecting other clients). Exercised through the real `dispatch()`.
  // -------------------------------------------------------------------

  it('delivers an event the per-client filter accepts', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = {
      ws,
      userId: 'user-1',
      subscribedTypes: new Set(['device.*']),
      filter: (e: Record<string, unknown>) => (e as any).payload?.siteId === 'site-a',
    };
    dispatcher.register('org-1', client);

    (dispatcher as any).dispatch(
      'org-1',
      JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: { siteId: 'site-a' } }),
    );
    expect(ws.send).toHaveBeenCalledTimes(1);

    dispatcher.unregister('org-1', client);
  });

  it('drops an event the per-client filter rejects', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = {
      ws,
      userId: 'user-1',
      subscribedTypes: new Set(['device.*']),
      filter: (e: Record<string, unknown>) => (e as any).payload?.siteId === 'site-a',
    };
    dispatcher.register('org-1', client);

    // Event subscribed-type matches, but the filter rejects it (wrong site).
    (dispatcher as any).dispatch(
      'org-1',
      JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: { siteId: 'site-b' } }),
    );
    expect(ws.send).not.toHaveBeenCalled();

    dispatcher.unregister('org-1', client);
  });

  it('fails closed when a filter throws: drops the event for that client without affecting others', () => {
    const dispatcher = getEventDispatcher();
    const filteredWs = mockWs();
    const plainWs = mockWs();

    const throwingClient = {
      ws: filteredWs,
      userId: 'user-throws',
      subscribedTypes: new Set(['device.*']),
      filter: () => {
        throw new Error('boom');
      },
    };
    // Second client on the SAME org with no filter — must still receive the event.
    const plainClient = {
      ws: plainWs,
      userId: 'user-plain',
      subscribedTypes: new Set(['device.*']),
    };
    dispatcher.register('org-1', throwingClient);
    dispatcher.register('org-1', plainClient);

    expect(() =>
      (dispatcher as any).dispatch(
        'org-1',
        JSON.stringify({ type: 'device.online', orgId: 'org-1', payload: { siteId: 'site-a' } }),
      ),
    ).not.toThrow();

    // Fail closed: the throwing client's event is dropped.
    expect(filteredWs.send).not.toHaveBeenCalled();
    // The unfiltered client on the same org is unaffected.
    expect(plainWs.send).toHaveBeenCalledTimes(1);

    dispatcher.unregister('org-1', throwingClient);
    dispatcher.unregister('org-1', plainClient);
  });

  // -------------------------------------------------------------------
  // End-to-end (#1280): a site-restricted client built with the REAL
  // `buildSiteFilter` (from eventWs.ts) receives in-site events and not
  // out-of-site ones, driven through the real `dispatch()` with
  // publish-shaped BreezeEvent messages carrying a TOP-LEVEL `siteId` (the
  // shape `publishEvent({ siteId })` now produces). This closes the loop
  // from publish → wire → dispatch filter that the issue asks to verify.
  // -------------------------------------------------------------------

  it('site-restricted client (real buildSiteFilter) gets in-site events, drops out-of-site (#1280)', () => {
    const dispatcher = getEventDispatcher();
    const restrictedWs = mockWs();
    const unrestrictedWs = mockWs();

    const restricted = {
      ws: restrictedWs,
      userId: 'site-user',
      subscribedTypes: new Set(['*']),
      filter: buildSiteFilter(['site-a']), // restricted to site-a
    };
    const unrestricted = {
      ws: unrestrictedWs,
      userId: 'org-admin',
      subscribedTypes: new Set(['*']),
      filter: buildSiteFilter(undefined), // full org access — undefined filter
    };
    dispatcher.register('org-1', restricted);
    dispatcher.register('org-1', unrestricted);

    // Publish-shaped event: siteId is a TOP-LEVEL field (as publishEvent emits).
    const inSite = JSON.stringify({
      id: 'e1',
      type: 'alert.triggered',
      orgId: 'org-1',
      siteId: 'site-a',
      source: 'alert-service',
      priority: 'normal',
      payload: { alertId: 'a1', deviceId: 'd1' },
      metadata: { timestamp: '2026-06-13T00:00:00Z' },
    });
    (dispatcher as any).dispatch('org-1', inSite);

    // Restricted client receives the in-site event; admin receives it too.
    expect(restrictedWs.send).toHaveBeenCalledTimes(1);
    expect(unrestrictedWs.send).toHaveBeenCalledTimes(1);

    restrictedWs.send.mockClear();
    unrestrictedWs.send.mockClear();

    // Out-of-site event (different site).
    const outOfSite = JSON.stringify({
      id: 'e2',
      type: 'alert.triggered',
      orgId: 'org-1',
      siteId: 'site-b',
      source: 'alert-service',
      priority: 'normal',
      payload: { alertId: 'a2', deviceId: 'd2' },
      metadata: { timestamp: '2026-06-13T00:00:01Z' },
    });
    (dispatcher as any).dispatch('org-1', outOfSite);

    // Restricted client does NOT receive it; admin still does.
    expect(restrictedWs.send).not.toHaveBeenCalled();
    expect(unrestrictedWs.send).toHaveBeenCalledTimes(1);

    dispatcher.unregister('org-1', restricted);
    dispatcher.unregister('org-1', unrestricted);
  });

  it('org-level event with no siteId is withheld from site-restricted clients, delivered to admins (#1280)', () => {
    const dispatcher = getEventDispatcher();
    const restrictedWs = mockWs();
    const unrestrictedWs = mockWs();

    const restricted = {
      ws: restrictedWs,
      userId: 'site-user',
      subscribedTypes: new Set(['*']),
      filter: buildSiteFilter(['site-a']),
    };
    const unrestricted = {
      ws: unrestrictedWs,
      userId: 'org-admin',
      subscribedTypes: new Set(['*']),
      filter: buildSiteFilter(undefined),
    };
    dispatcher.register('org-1', restricted);
    dispatcher.register('org-1', unrestricted);

    // Genuinely org-level event — no siteId on the wire (e.g. user.login).
    const orgLevel = JSON.stringify({
      id: 'e3',
      type: 'user.login',
      orgId: 'org-1',
      source: 'auth',
      priority: 'normal',
      payload: { userId: 'u1' },
      metadata: { timestamp: '2026-06-13T00:00:02Z' },
    });
    (dispatcher as any).dispatch('org-1', orgLevel);

    // Fail-closed policy: site-restricted user is withheld; admin still gets it.
    expect(restrictedWs.send).not.toHaveBeenCalled();
    expect(unrestrictedWs.send).toHaveBeenCalledTimes(1);

    dispatcher.unregister('org-1', restricted);
    dispatcher.unregister('org-1', unrestricted);
  });

  it('drops the org from the in-memory routing map when its last client disconnects, without tearing down the shared Redis connection', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    dispatcher.register('org-1', client);

    expect((dispatcher as any).clients.has('org-1')).toBe(true);

    dispatcher.unregister('org-1', client);
    expect((dispatcher as any).clients.has('org-1')).toBe(false);
    // The shared connection is a process-wide resource, not a per-org one —
    // the whole point of the fix is that org churn no longer opens/closes a
    // Redis connection at all. It stays up until shutdown().
    expect((dispatcher as any).sharedSubscriber).not.toBeNull();
    expect((dispatcher as any).sharedSubscriber.quit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Finding: one Redis connection per org per process, unbounded, is what a
  // large org-access-all partner (or organic org growth) exhausts Redis
  // `maxclients` with. These prove the fix directly: ONE shared connection
  // regardless of how many orgs are registered, routed via PSUBSCRIBE + the
  // channel name in `pmessage`, not one SUBSCRIBE per org.
  // -------------------------------------------------------------------
  describe('shared Redis subscriber (one connection per process, not one per org)', () => {
    it('opens exactly ONE Redis connection for many distinct orgs', () => {
      const dispatcher = getEventDispatcher();
      const clients = Array.from({ length: 50 }, (_, i) => ({
        ws: mockWs(),
        userId: `user-${i}`,
        subscribedTypes: new Set(['device.*']),
      }));
      clients.forEach((client, i) => dispatcher.register(`org-${i}`, client));

      expect(mockRedisInstances).toHaveLength(1);
      expect(mockRedisInstances[0]!.psubscribeMock).toHaveBeenCalledTimes(1);
      expect(mockRedisInstances[0]!.psubscribeMock.mock.calls[0]![0]).toBe('breeze:events:live:*');

      clients.forEach((client, i) => dispatcher.unregister(`org-${i}`, client));
      // A second wave of orgs after the first fully drains still reuses the
      // same connection — it is process-scoped, not tied to any one org's
      // lifetime.
      const client2 = { ws: mockWs(), userId: 'user-later', subscribedTypes: new Set(['device.*']) };
      dispatcher.register('org-later', client2);
      expect(mockRedisInstances).toHaveLength(1);
      dispatcher.unregister('org-later', client2);
    });

    it('routes an incoming pmessage to only the clients registered for that channel\'s org', () => {
      const dispatcher = getEventDispatcher();
      const ws1 = mockWs();
      const ws2 = mockWs();
      const client1 = { ws: ws1, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
      const client2 = { ws: ws2, userId: 'user-2', subscribedTypes: new Set(['device.*']) };
      dispatcher.register('org-a', client1);
      dispatcher.register('org-b', client2);

      mockRedisInstances[0]!.emitPmessage(
        'breeze:events:live:org-a',
        JSON.stringify({ type: 'device.online', orgId: 'org-a', payload: {} }),
      );

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();

      dispatcher.unregister('org-a', client1);
      dispatcher.unregister('org-b', client2);
    });

    it('ignores a pmessage on a channel outside the live-event prefix', () => {
      const dispatcher = getEventDispatcher();
      const ws = mockWs();
      const client = { ws, userId: 'user-1', subscribedTypes: new Set(['*']) };
      dispatcher.register('org-a', client);

      expect(() =>
        mockRedisInstances[0]!.emitPmessage('breeze:events:global', JSON.stringify({ type: 'device.online' })),
      ).not.toThrow();
      expect(ws.send).not.toHaveBeenCalled();

      dispatcher.unregister('org-a', client);
    });

    it('clears the shared connection and lets the next register() retry when the initial psubscribe fails', () => {
      // Force the FIRST connection's psubscribe to fail.
      const dispatcher = getEventDispatcher();
      const ws = mockWs();
      const client = { ws, userId: 'user-1', subscribedTypes: new Set(['device.*']) };

      // Patch the constructor's next instance to report a subscribe failure.
      const origPsubscribe = MockRedis.prototype.psubscribe;
      MockRedis.prototype.psubscribe = function (
        this: InstanceType<typeof MockRedis>,
        pattern: string,
        cb: (err: Error | null, count?: number) => void,
      ) {
        cb(new Error('ECONNREFUSED'));
        return undefined as unknown as ReturnType<typeof origPsubscribe>;
      };

      dispatcher.register('org-a', client);
      expect(mockRedisInstances).toHaveLength(1);
      expect((dispatcher as any).sharedSubscriber).toBeNull();
      expect(mockRedisInstances[0]!.quit).toHaveBeenCalledTimes(1);

      // Restore, and prove the NEXT register() opens a fresh connection
      // rather than being permanently stuck with no subscriber (the exact
      // bug this replaces: the old per-org map left `clients[orgId]`
      // present with a deleted subscriber, silently starving that org of
      // events until every client disconnected).
      MockRedis.prototype.psubscribe = origPsubscribe;
      const client2 = { ws: mockWs(), userId: 'user-2', subscribedTypes: new Set(['device.*']) };
      dispatcher.register('org-b', client2);
      expect(mockRedisInstances).toHaveLength(2);
      expect((dispatcher as any).sharedSubscriber).not.toBeNull();

      dispatcher.unregister('org-a', client);
      dispatcher.unregister('org-b', client2);
    });
  });
});
