import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('./redis', () => ({
  getRedis: vi.fn(),
  getRedisConnection: vi.fn(),
  createBlockingRedisConnection: vi.fn()
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

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

// eventDispatchQueue (wave 3.5c, #4085) is mocked wholesale so publish()'s
// wiring can be asserted (called / not called, with what args) without
// depending on a real BullMQ queue or Redis connection — matching the
// './redis' + '../db' mocking pattern already used in this file.
vi.mock('./eventDispatchQueue', () => ({
  enqueueRouteEvent: vi.fn().mockResolvedValue(undefined),
  recordShadowLocalInvocation: vi.fn().mockResolvedValue(undefined),
}));

describe('eventBus service', () => {
  let mockRedis: Partial<Redis>;
  let eventBusModule: typeof import('./eventBus');
  let getRedis: (typeof import('./redis'))['getRedis'];
  let getRedisConnection: (typeof import('./redis'))['getRedisConnection'];
  let enqueueRouteEvent: (typeof import('./eventDispatchQueue'))['enqueueRouteEvent'];
  let recordShadowLocalInvocation: (typeof import('./eventDispatchQueue'))['recordShadowLocalInvocation'];

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockRedis = {
      xadd: vi.fn().mockResolvedValue('0-0'),
      publish: vi.fn().mockResolvedValue(1),
      xack: vi.fn().mockResolvedValue(1),
      lpush: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      status: 'ready'
    };

    eventBusModule = await import('./eventBus');
    ({ getRedis, getRedisConnection } = await import('./redis'));
    vi.mocked(getRedis).mockReturnValue(mockRedis as Redis);
    vi.mocked(getRedisConnection).mockReturnValue(mockRedis as Redis);

    ({ enqueueRouteEvent, recordShadowLocalInvocation } = await import('./eventDispatchQueue'));
    vi.mocked(enqueueRouteEvent).mockClear().mockResolvedValue(undefined);
    vi.mocked(recordShadowLocalInvocation).mockClear().mockResolvedValue(undefined);

    const { _resetEventSubscriberRegistryForTests } = await import('./eventSubscriberRegistry');
    _resetEventSubscriberRegistryForTests();
  });

  describe('publishUserEvent — addressed to one user', () => {
    it('writes ONLY the live channel: no stream, no global channel', async () => {
      // This is the containment property. publish() also writes the org's Redis
      // STREAM (persisted), the GLOBAL cross-org channel that webhook delivery
      // subscribes to, and every local wildcard handler. A private
      // notification taking that path would be persisted for anything reading
      // the stream and could be forwarded to a customer's webhook endpoint.
      const { getEventBus } = eventBusModule;

      const eventId = await getEventBus().publishUserEvent(
        'notification.created',
        'org-1',
        'user-alice',
        { notificationId: 'n-1' },
        'unit-test',
      );

      expect(mockRedis.xadd).not.toHaveBeenCalled();

      const publishMock = mockRedis.publish as ReturnType<typeof vi.fn>;
      expect(publishMock).toHaveBeenCalledTimes(1);
      const [channel, body] = publishMock.mock.calls[0]!;
      expect(channel).toBe('breeze:events:live:org-1');
      expect(channel).not.toContain('global');

      const event = JSON.parse(body as string) as Record<string, unknown>;
      expect(event.id).toBe(eventId);
      expect(event.audienceUserId).toBe('user-alice');
      // Content-free by design: the WS transport fans out per ORG, so this id
      // is all that crosses it and the client refetches behind RLS.
      expect(event.payload).toEqual({ notificationId: 'n-1' });
    });

    it('does not invoke local wildcard handlers', async () => {
      // webhookDelivery and automationWorker both subscribe to '*'. An
      // addressed notification must not trigger an automation or a webhook.
      const { getEventBus } = eventBusModule;
      const bus = getEventBus();
      const wildcard = vi.fn();
      bus.subscribe('*', wildcard);

      await bus.publishUserEvent(
        'notification.created', 'org-1', 'user-alice', { notificationId: 'n-1' }, 'unit-test',
      );

      expect(wildcard).not.toHaveBeenCalled();
    });

    it('escapes the DB transaction context before touching Redis', async () => {
      // Same #815 reason as publish(): never hold a Postgres connection
      // idle-in-transaction across Redis-bound work.
      const { getEventBus } = eventBusModule;
      const { runOutsideDbContext } = await import('../db');

      await getEventBus().publishUserEvent(
        'notification.created', 'org-1', 'user-alice', { notificationId: 'n-1' }, 'unit-test',
      );

      expect(runOutsideDbContext).toHaveBeenCalled();
    });
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

  it('should invoke subscribed handlers on publish (local in-process delivery)', async () => {
    const { getEventBus, publishEvent, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, handler);

    const eventId = await publishEvent(
      EVENT_TYPES.DEVICE_ENROLLED,
      'org-1',
      { deviceId: 'dev-1' },
      'unit-test'
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({
      id: eventId,
      type: EVENT_TYPES.DEVICE_ENROLLED,
      orgId: 'org-1',
      payload: { deviceId: 'dev-1' },
    });
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

  // ---------------------------------------------------------------------
  // siteId attribution on the published event (#1280 — eventWs follow-up).
  // The events-WS site filter (routes/eventWs.ts) delivers in-site live
  // events to site-restricted users by reading the TOP-LEVEL `siteId` off the
  // published BreezeEvent. These assert publish() puts it there from options.
  // ---------------------------------------------------------------------

  function lastPublishedEvent(): Record<string, unknown> {
    const xaddMock = mockRedis.xadd as ReturnType<typeof vi.fn>;
    const lastCall = xaddMock.mock.calls[xaddMock.mock.calls.length - 1]!;
    const eventJson = lastCall[lastCall.length - 1] as string;
    return JSON.parse(eventJson) as Record<string, unknown>;
  }

  it('puts options.siteId on the published event as a top-level field (#1280)', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;

    await publishEvent(
      EVENT_TYPES.ALERT_TRIGGERED,
      'org-1',
      { deviceId: 'dev-1', alertId: 'a-1' },
      'unit-test',
      { siteId: 'site-a' },
    );

    const event = lastPublishedEvent();
    expect(event.siteId).toBe('site-a');
    // payload is left untouched — siteId lives at the top level where the
    // WS filter reads it first.
    expect((event.payload as Record<string, unknown>).siteId).toBeUndefined();
  });

  it('omits siteId entirely when no site context is provided (org-level event)', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;

    await publishEvent(EVENT_TYPES.USER_LOGIN, 'org-1', { userId: 'u-1' }, 'unit-test');

    const event = lastPublishedEvent();
    expect('siteId' in event).toBe(false);
  });

  it('normalises an empty-string siteId to "no attribution" (never matches a blank id)', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;

    await publishEvent(
      EVENT_TYPES.DEVICE_OFFLINE,
      'org-1',
      { deviceId: 'dev-1' },
      'unit-test',
      { siteId: '' },
    );

    const event = lastPublishedEvent();
    expect('siteId' in event).toBe(false);
  });

  it('treats a null siteId option as no attribution', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;

    await publishEvent(
      EVENT_TYPES.DEVICE_OFFLINE,
      'org-1',
      { deviceId: 'dev-1' },
      'unit-test',
      { siteId: null },
    );

    const event = lastPublishedEvent();
    expect('siteId' in event).toBe(false);
  });

  it('should unsubscribe handlers', async () => {
    const { getEventBus, publishEvent, EVENT_TYPES } = eventBusModule;
    const bus = getEventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    const unsubscribe = bus.subscribe(EVENT_TYPES.DEVICE_ENROLLED, handler);
    unsubscribe();

    await publishEvent(
      EVENT_TYPES.DEVICE_ENROLLED,
      'org-1',
      { deviceId: 'dev-2' },
      'unit-test'
    );

    expect(handler).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Registry-aware local delivery (wave 3.5c, #4085).
  // ---------------------------------------------------------------------

  describe('registry-aware local delivery', () => {
    it('a registered local subscriber receives published events', async () => {
      const { publishEvent, EVENT_TYPES } = eventBusModule;
      const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
      const handler = vi.fn().mockResolvedValue(undefined);

      registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler,
      });

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        type: EVENT_TYPES.DEVICE_ENROLLED,
        orgId: 'org-1',
      });
    });

    it('a queue-partitioned subscriber (enforce + csv) is NOT invoked locally', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery');

      const { publishEvent, EVENT_TYPES } = eventBusModule;
      const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
      const queuedHandler = vi.fn().mockResolvedValue(undefined);
      const localHandler = vi.fn().mockResolvedValue(undefined);

      registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler: queuedHandler,
      });
      registerEventSubscriber({
        id: 'automation-worker',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler: localHandler,
      });

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(queuedHandler).not.toHaveBeenCalled();
      expect(localHandler).toHaveBeenCalledTimes(1);

      vi.unstubAllEnvs();
    });

    it('a throwing registered subscriber logs EVENT_BUS_LOCAL_HANDLER_FAILED with its subscriberId and does not affect later subscribers', async () => {
      const { publishEvent, EVENT_TYPES } = eventBusModule;
      const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
      const { captureException } = await import('./sentry');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const failingHandler = vi.fn().mockRejectedValue(new Error('registry subscriber boom'));
      const survivingHandler = vi.fn().mockResolvedValue(undefined);

      // 'automation-worker' sorts before 'webhook-delivery' by localeCompare,
      // so this also proves the failure doesn't halt the sorted iteration.
      registerEventSubscriber({
        id: 'automation-worker',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler: failingHandler,
      });
      registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler: survivingHandler,
      });

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(failingHandler).toHaveBeenCalledTimes(1);
      expect(survivingHandler).toHaveBeenCalledTimes(1);

      const localFailLogs = errorSpy.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('local-handler-failed'),
      );
      expect(localFailLogs).toHaveLength(1);
      const payload = JSON.parse(localFailLogs[0]![1] as string);
      expect(payload.errorId).toBe('EVENT_BUS_LOCAL_HANDLER_FAILED');
      expect(payload.subscriberId).toBe('automation-worker');
      expect(payload.error.message).toBe('registry subscriber boom');

      expect(captureException).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------
  // Dispatch-queue ingress wiring (wave 3.5c, #4085 task 5).
  // ---------------------------------------------------------------------

  describe('dispatch-queue ingress wiring', () => {
    it('does NOT call enqueueRouteEvent when EVENT_DISPATCH_MODE is off (default)', async () => {
      const { publishEvent, EVENT_TYPES } = eventBusModule;

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(enqueueRouteEvent).not.toHaveBeenCalled();
    });

    it('calls enqueueRouteEvent with the published event when mode is shadow', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const { publishEvent, EVENT_TYPES } = eventBusModule;

      const eventId = await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(enqueueRouteEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueRouteEvent).mock.calls[0]![0]).toMatchObject({ id: eventId, type: EVENT_TYPES.DEVICE_ENROLLED });

      vi.unstubAllEnvs();
    });

    it('calls enqueueRouteEvent when mode is enforce', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      const { publishEvent, EVENT_TYPES } = eventBusModule;

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(enqueueRouteEvent).toHaveBeenCalledTimes(1);

      vi.unstubAllEnvs();
    });

    it('runs enqueueRouteEvent BEFORE invokeLocalHandlers (registry subscribers)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const { publishEvent, EVENT_TYPES } = eventBusModule;
      const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
      const handler = vi.fn().mockResolvedValue(undefined);
      registerEventSubscriber({ id: 'webhook-delivery', eventTypes: [EVENT_TYPES.DEVICE_ENROLLED], handler });

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      const enqueueOrder = vi.mocked(enqueueRouteEvent).mock.invocationCallOrder[0]!;
      const handlerOrder = handler.mock.invocationCallOrder[0]!;
      expect(enqueueOrder).toBeLessThan(handlerOrder);

      vi.unstubAllEnvs();
    });

    it('publishUserEvent NEVER calls enqueueRouteEvent, even in shadow/enforce mode', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      const { getEventBus } = eventBusModule;

      await getEventBus().publishUserEvent(
        'notification.created', 'org-1', 'user-alice', { notificationId: 'n-1' }, 'unit-test',
      );

      expect(enqueueRouteEvent).not.toHaveBeenCalled();

      vi.unstubAllEnvs();
    });
  });

  describe('shadow-mode local-invocation bookkeeping wiring', () => {
    it('records "ok" for a successful local subscriber', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const { publishEvent, EVENT_TYPES } = eventBusModule;
      const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
      registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler: vi.fn().mockResolvedValue(undefined),
      });

      await publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');

      expect(recordShadowLocalInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ type: EVENT_TYPES.DEVICE_ENROLLED }),
        'webhook-delivery',
        'ok',
      );

      vi.unstubAllEnvs();
    });

    it('records "error" for a failing local subscriber, and does not let a rejected bookkeeping call escape', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      vi.mocked(recordShadowLocalInvocation).mockRejectedValueOnce(new Error('redis down'));
      const { publishEvent, EVENT_TYPES } = eventBusModule;
      const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
      registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
        handler: vi.fn().mockRejectedValue(new Error('handler boom')),
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test'),
      ).resolves.toEqual(expect.any(String));

      expect(recordShadowLocalInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ type: EVENT_TYPES.DEVICE_ENROLLED }),
        'webhook-delivery',
        'error',
      );

      // Fire-and-forget: publish() must not reject just because the shadow
      // bookkeeping call rejected. Flush microtasks so the .catch() runs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).toHaveBeenCalledWith('[EventBus] shadow-record-failed', expect.any(Error));

      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
  });

  // ---------------------------------------------------------------------
  // Carried fix from the Task 2 review (#4085): a throwing captureException
  // must not escape invokeLocalHandlers and reject publish().
  // ---------------------------------------------------------------------

  it('a throwing captureException does not reject publish() (carried fix, #4085 task 5)', async () => {
    const { publishEvent, EVENT_TYPES } = eventBusModule;
    const { registerEventSubscriber } = await import('./eventSubscriberRegistry');
    const { captureException } = await import('./sentry');
    vi.mocked(captureException).mockImplementationOnce(() => {
      throw new Error('sentry sdk misconfigured');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    registerEventSubscriber({
      id: 'webhook-delivery',
      eventTypes: [EVENT_TYPES.DEVICE_ENROLLED],
      handler: vi.fn().mockRejectedValue(new Error('handler boom')),
    });

    await expect(
      publishEvent(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test'),
    ).resolves.toEqual(expect.any(String));

    vi.restoreAllMocks();
  });

  describe('EventBus.close() — must not quit the shared connection (#4086)', () => {
    it('does not call .quit() on the borrowed getRedisConnection() singleton', async () => {
      const { getEventBus, EVENT_TYPES } = eventBusModule;
      const bus = getEventBus();

      // Drive getOrCreateRedis() so the bus holds a reference to the shared
      // connection before closing it.
      await bus.publish(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');
      expect(mockRedis.publish as ReturnType<typeof vi.fn>).toHaveBeenCalled();

      await bus.close();

      // closeRedis() is the sole owner of the shared connection's .quit() —
      // EventBus.close() only releases its own reference.
      expect(mockRedis.quit).not.toHaveBeenCalled();
    });

    it('re-acquires the connection via getRedisConnection() on the next publish after close()', async () => {
      const { getEventBus, EVENT_TYPES } = eventBusModule;
      const bus = getEventBus();

      await bus.publish(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-1' }, 'unit-test');
      const callsBeforeClose = (getRedisConnection as ReturnType<typeof vi.fn>).mock.calls.length;

      await bus.close();
      await bus.publish(EVENT_TYPES.DEVICE_ENROLLED, 'org-1', { deviceId: 'dev-2' }, 'unit-test');

      expect((getRedisConnection as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBeforeClose);
    });
  });
});
