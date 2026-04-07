import { describe, it, expect, vi, afterEach } from 'vitest';
import { matchesEventType, getEventDispatcher, shutdownEventDispatcher } from './eventDispatcher';

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
