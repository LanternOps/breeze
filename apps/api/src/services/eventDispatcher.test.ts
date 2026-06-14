import { describe, it, expect, vi, afterEach } from 'vitest';
import { matchesEventType, getEventDispatcher, shutdownEventDispatcher } from './eventDispatcher';
import { buildSiteFilter } from '../routes/eventWs';

vi.mock('./redis', () => ({
  resolveRedisUrl: () => 'redis://localhost:6379',
}));

vi.mock('ioredis', () => {
  class MockRedis {
    subscribe = vi.fn((_channel: string, cb: (err: Error | null) => void) => cb(null));
    unsubscribe = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
  }
  return { default: MockRedis };
});

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

  it('unsubscribes from Redis when last client for org disconnects', () => {
    const dispatcher = getEventDispatcher();
    const ws = mockWs();
    const client = { ws, userId: 'user-1', subscribedTypes: new Set(['device.*']) };
    dispatcher.register('org-1', client);

    // Verify org has subscribers
    expect((dispatcher as any).clients.has('org-1')).toBe(true);

    dispatcher.unregister('org-1', client);
    expect((dispatcher as any).clients.has('org-1')).toBe(false);
  });
});
