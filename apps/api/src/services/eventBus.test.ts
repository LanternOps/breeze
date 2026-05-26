import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('./redis', () => ({
  getRedis: vi.fn(),
  getRedisConnection: vi.fn()
}));

// Mock the db module so we can assert `runOutsideDbContext` is invoked
// from `publish()`. PR #815 added `runOutsideDbContext` to fix an
// `idle in transaction` leak (2026-05-21 prod login lockout); the
// regression test below makes a future "wrap publish in try/catch
// for resilience" refactor visibly fail if it deletes that call.
vi.mock('../db', () => {
  const runOutsideDbContext = vi.fn(<T>(fn: () => T): T => fn());
  return {
    runOutsideDbContext,
    // No other db exports are reached by eventBus.ts at module init,
    // but stub the surface so a stray import doesn't blow up.
    db: {},
  };
});

describe('eventBus service', () => {
  let mockRedis: Partial<Redis>;
  let eventBusModule: typeof import('./eventBus');
  let getRedis: (typeof import('./redis'))['getRedis'];
  let getRedisConnection: (typeof import('./redis'))['getRedisConnection'];

  beforeEach(async () => {
    vi.resetModules();
    mockRedis = {
      xadd: vi.fn().mockResolvedValue('0-0'),
      publish: vi.fn().mockResolvedValue(1),
      xack: vi.fn().mockResolvedValue(1),
      lpush: vi.fn().mockResolvedValue(1)
    };

    eventBusModule = await import('./eventBus');
    ({ getRedis, getRedisConnection } = await import('./redis'));
    vi.mocked(getRedis).mockReturnValue(mockRedis as Redis);
    vi.mocked(getRedisConnection).mockReturnValue(mockRedis as Redis);
  });

  it('should publish events to stream and pubsub channels', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;

    const eventId = await publishEvent(
      EVENT_TYPES.DEVICE_ENROLLED,
      'org-1',
      { deviceId: 'dev-1' },
      'unit-test'
    );

    expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
    const xaddMock = mockRedis.xadd as ReturnType<typeof vi.fn>;
    const xaddArgs = xaddMock.mock.calls[0]!;
    const eventJson = xaddArgs[xaddArgs.length - 1] as string;
    const event = JSON.parse(eventJson) as Record<string, unknown> & { metadata: Record<string, unknown> };

    expect(event.id).toBe(eventId);
    expect(event.metadata.correlationId).toBe(eventId);
    expect(event.type).toBe(EVENT_TYPES.DEVICE_ENROLLED);
    expect(event.orgId).toBe('org-1');
    expect(event.source).toBe('unit-test');
    expect(event.priority).toBe('normal');
    expect(event.payload).toEqual({ deviceId: 'dev-1' });
    expect(event.metadata.timestamp).toEqual(expect.any(String));

    expect(mockRedis.publish).toHaveBeenCalledWith(
      'breeze:events:live:org-1',
      eventJson
    );
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'breeze:events:global',
      eventJson
    );
  });

  it('should invoke subscribed handlers and acknowledge the message', async () => {
    const { getEventBus, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, handler);

    const event = {
      id: 'evt-1',
      type: EVENT_TYPES.DEVICE_ENROLLED,
      orgId: 'org-1',
      source: 'unit-test',
      priority: 'normal',
      payload: { deviceId: 'dev-1' },
      metadata: {
        timestamp: new Date().toISOString()
      }
    };

    await (bus as any).processMessage(
      '123-0',
      ['event', JSON.stringify(event)],
      mockRedis as Redis
    );

    expect(handler).toHaveBeenCalledWith(event);
    expect(mockRedis.xack).toHaveBeenCalledWith(
      'breeze:events:org-1',
      'breeze-api',
      '123-0'
    );
  });

  // ---------------------------------------------------------------------
  // Regression coverage for PR #815 + #820.
  // ---------------------------------------------------------------------

  it('publish() invokes runOutsideDbContext exactly once per publish (regression for #815)', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;
    const { runOutsideDbContext } = await import('../db');
    vi.mocked(runOutsideDbContext).mockClear();

    await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    // Redis ops must run INSIDE the wrapped block, not before / after.
    const callOrder = (runOutsideDbContext as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const xaddOrder = (mockRedis.xadd as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(xaddOrder).toBeGreaterThan(callOrder);
  });

  it('publishEvent rejects when redis.xadd rejects (underpins caller-tx-rolls-back guarantee)', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;
    (mockRedis.xadd as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'));

    await expect(
      publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test'),
    ).rejects.toThrow(/redis down/);
  });

  it('local-handler failure emits structured log + does NOT stop subsequent handlers (issue #820)', async () => {
    const { getEventBus, publishEvent, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failingHandler = vi.fn().mockRejectedValue(new Error('boom'));
    const survivingHandler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, failingHandler);
    bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, survivingHandler);

    await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

    // Both handlers were given a turn — one failure doesn't stop the loop.
    expect(failingHandler).toHaveBeenCalledTimes(1);
    expect(survivingHandler).toHaveBeenCalledTimes(1);

    // The failure is logged structurally (JSON in the second console.error arg)
    // so ops can grep / forward / aggregate.
    const localFailLogs = errorSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('local-handler-failed'),
    );
    expect(localFailLogs).toHaveLength(1);
    const payload = JSON.parse(localFailLogs[0]![1] as string);
    expect(payload.errorId).toBe('EVENT_BUS_LOCAL_HANDLER_FAILED');
    expect(payload.eventType).toBe(EVENT_TYPES.DEVICE_ENROLLED);
    expect(payload.orgId).toBe('org-1');
    expect(payload.source).toBe('unit-test');
    expect(payload.eventId).toEqual(expect.any(String));
    expect(payload.handlerIndex).toBe(0);
    expect(payload.error.message).toBe('boom');

    errorSpy.mockRestore();
  });

  it('exports DNS_THREAT_BLOCKED = "dns.threat.blocked" so dnsSyncJob can emit and consumers can subscribe (#829)', async () => {
    const { EVENT_TYPES, publishEvent } = eventBusModule;
    expect(EVENT_TYPES.DNS_THREAT_BLOCKED).toBe('dns.threat.blocked');

    // Smoke-check the new event type is wired into the EventType union too
    // (publishEvent's signature would reject a string not in the union).
    const eventId = await publishEvent(
      EVENT_TYPES.DNS_THREAT_BLOCKED,
      'org-1',
      {
        deviceId: 'dev-1',
        domain: 'malware.example.com',
        category: 'malware',
        integrationId: 'int-1',
        timestamp: new Date().toISOString(),
      },
      'dns-sync-job',
      { priority: 'high' }
    );
    expect(eventId).toEqual(expect.any(String));

    const xaddMock = mockRedis.xadd as ReturnType<typeof vi.fn>;
    const lastCall = xaddMock.mock.calls[xaddMock.mock.calls.length - 1]!;
    const eventJson = lastCall[lastCall.length - 1] as string;
    const event = JSON.parse(eventJson);
    expect(event.type).toBe('dns.threat.blocked');
    expect(event.priority).toBe('high');
    expect(event.payload.domain).toBe('malware.example.com');
  });

  it('should unsubscribe handlers', async () => {
    const { getEventBus, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    const unsubscribe = bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, handler);
    unsubscribe();

    const event = {
      id: 'evt-2',
      type: EVENT_TYPES.DEVICE_ENROLLED,
      orgId: 'org-1',
      source: 'unit-test',
      priority: 'normal',
      payload: { deviceId: 'dev-2' },
      metadata: {
        timestamp: new Date().toISOString()
      }
    };

    await (bus as any).processMessage(
      '124-0',
      ['event', JSON.stringify(event)],
      mockRedis as Redis
    );

    expect(handler).not.toHaveBeenCalled();
    expect(mockRedis.xack).toHaveBeenCalledWith(
      'breeze:events:org-1',
      'breeze-api',
      '124-0'
    );
  });
});
