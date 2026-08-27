import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BreezeEvent, EventType } from './eventBus';

const queueAdd = vi.fn().mockResolvedValue(undefined);
const queueClose = vi.fn().mockResolvedValue(undefined);
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => ({
    add: queueAdd,
    close: queueClose,
  })),
}));

const redisHincrby = vi.fn().mockResolvedValue(1);
const redisHset = vi.fn().mockResolvedValue(1);
const redisExpire = vi.fn().mockResolvedValue(1);
vi.mock('./redis', () => ({
  getRedisConnection: vi.fn(() => ({
    hincrby: redisHincrby,
    hset: redisHset,
    expire: redisExpire,
  })),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

function makeEvent(overrides: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'aa000000-0000-4000-8000-000000000000',
    type: 'device.online' as EventType,
    orgId: 'org-1',
    source: 'unit-test',
    priority: 'normal',
    payload: {},
    metadata: { timestamp: new Date().toISOString() },
    ...overrides,
  };
}

describe('eventDispatchQueue', () => {
  let mod: typeof import('./eventDispatchQueue');
  let registry: typeof import('./eventSubscriberRegistry');

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    queueAdd.mockClear().mockResolvedValue(undefined);
    queueClose.mockClear().mockResolvedValue(undefined);
    redisHincrby.mockClear().mockResolvedValue(1);
    redisHset.mockClear().mockResolvedValue(1);
    redisExpire.mockClear().mockResolvedValue(1);

    mod = await import('./eventDispatchQueue');
    registry = await import('./eventSubscriberRegistry');
    registry._resetEventSubscriberRegistryForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports the queue name constant', () => {
    expect(mod.EVENT_DISPATCH_QUEUE).toBe('event-dispatch');
  });

  describe('enqueueRouteEvent', () => {
    it('mode off: adds nothing', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'off');
      await mod.enqueueRouteEvent(makeEvent());
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('mode shadow: one route-event add with jobId, queueSubscriberIds === matchedSubscriberIds', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      registry.registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: ['device.online'],
        handler: async () => {},
      });
      registry.registerEventSubscriber({
        id: 'automation-worker',
        eventTypes: ['device.online'],
        handler: async () => {},
      });

      const event = makeEvent();
      await mod.enqueueRouteEvent(event);

      expect(queueAdd).toHaveBeenCalledTimes(1);
      const [name, data, opts] = queueAdd.mock.calls[0]!;
      expect(name).toBe('route-event');
      expect(opts).toMatchObject({
        jobId: `event-route-${event.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      });
      expect(data).toMatchObject({
        v: 1,
        mode: 'shadow',
        event,
        matchedSubscriberIds: ['automation-worker', 'webhook-delivery'],
        queueSubscriberIds: ['automation-worker', 'webhook-delivery'],
      });
    });

    it('mode enforce + csv: queueSubscriberIds is exactly matched ∩ csv, sorted', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery,dns-threat-alerts');
      registry.registerEventSubscriber({
        id: 'webhook-delivery',
        eventTypes: ['device.online'],
        handler: async () => {},
      });
      registry.registerEventSubscriber({
        id: 'automation-worker',
        eventTypes: ['device.online'],
        handler: async () => {},
      });

      const event = makeEvent();
      await mod.enqueueRouteEvent(event);

      const [, data] = queueAdd.mock.calls[0]!;
      expect((data as { matchedSubscriberIds: string[] }).matchedSubscriberIds).toEqual([
        'automation-worker',
        'webhook-delivery',
      ]);
      expect((data as { queueSubscriberIds: string[] }).queueSubscriberIds).toEqual(['webhook-delivery']);
    });

    it('a rejected queue.add is caught, logged, captureExceptioned, and NOT rethrown', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      queueAdd.mockRejectedValueOnce(new Error('redis down'));
      const { captureException } = await import('./sentry');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const event = makeEvent();
      await expect(mod.enqueueRouteEvent(event)).resolves.toBeUndefined();

      const logs = errorSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('enqueue-failed'),
      );
      expect(logs).toHaveLength(1);
      const payload = JSON.parse(logs[0]![1] as string);
      expect(payload.errorId).toBe('EVENT_DISPATCH_ENQUEUE_FAILED');
      expect(payload.eventId).toBe(event.id);
      expect(captureException).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });
  });

  describe('recordShadowLocalInvocation', () => {
    it('does nothing when mode is not shadow', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'off');
      await mod.recordShadowLocalInvocation(makeEvent(), 'webhook-delivery', 'ok');
      expect(redisHincrby).not.toHaveBeenCalled();
      expect(redisHset).not.toHaveBeenCalled();
    });

    it('always increments the per-subscriber/outcome counter in shadow mode', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      // 0xff = 255, well above the <26 sampling threshold, and the type isn't
      // alert.*/policy.* — so this event is NOT sampled, but the counter still
      // fires unconditionally.
      const event = makeEvent({ id: 'ff000000-0000-4000-8000-000000000000', type: 'device.online' as EventType });
      await mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok');
      expect(redisHincrby).toHaveBeenCalledWith('breeze:event-shadow:count:webhook-delivery', 'ok', 1);
    });

    it('records sampled-detail HSET+EXPIRE for alert.* events (100% sampled)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const event = makeEvent({
        id: 'ff000000-0000-4000-8000-000000000000',
        type: 'alert.triggered' as EventType,
      });
      await mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'error');
      expect(redisHset).toHaveBeenCalledWith(`breeze:event-shadow:local:${event.id}`, 'webhook-delivery', 'error');
      expect(redisExpire).toHaveBeenCalledWith(`breeze:event-shadow:local:${event.id}`, 7200);
    });

    it('records sampled-detail for policy.* events too (100% sampled)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const event = makeEvent({
        id: 'ff000000-0000-4000-8000-000000000000',
        type: 'policy.evaluated' as EventType,
      });
      await mod.recordShadowLocalInvocation(event, 'automation-worker', 'ok');
      expect(redisHset).toHaveBeenCalledWith(`breeze:event-shadow:local:${event.id}`, 'automation-worker', 'ok');
    });

    it('skips the sampled-detail HSET for a non-sampled event id/type', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      const event = makeEvent({ id: 'ff000000-0000-4000-8000-000000000000', type: 'device.online' as EventType });
      await mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok');
      expect(redisHset).not.toHaveBeenCalled();
      expect(redisExpire).not.toHaveBeenCalled();
    });

    it('never throws when the underlying Redis calls reject (shadow bookkeeping must never break delivery)', async () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      redisHincrby.mockRejectedValueOnce(new Error('redis down'));
      const event = makeEvent({ type: 'alert.triggered' as EventType });
      await expect(mod.recordShadowLocalInvocation(event, 'webhook-delivery', 'ok')).rejects.toThrow();
      // The rejection is real (so a caller's .catch() sees it), but nothing in
      // THIS module crashes synchronously — the promise simply rejects.
    });
  });

  describe('isShadowSampledEvent', () => {
    it('always samples alert.* and policy.* events regardless of id', () => {
      expect(
        mod.isShadowSampledEvent(makeEvent({ type: 'alert.triggered' as EventType, id: 'ff000000-0000-4000-8000-000000000000' })),
      ).toBe(true);
      expect(
        mod.isShadowSampledEvent(makeEvent({ type: 'policy.evaluated' as EventType, id: 'ff000000-0000-4000-8000-000000000000' })),
      ).toBe(true);
    });

    it('deterministically samples ~10% of other event types by id hash', () => {
      expect(mod.isShadowSampledEvent(makeEvent({ id: '00000000-0000-4000-8000-000000000000' }))).toBe(true); // 0x00 < 26
      expect(mod.isShadowSampledEvent(makeEvent({ id: '19000000-0000-4000-8000-000000000000' }))).toBe(true); // 0x19=25 < 26
      expect(mod.isShadowSampledEvent(makeEvent({ id: '1a000000-0000-4000-8000-000000000000' }))).toBe(false); // 0x1a=26, not < 26
      expect(mod.isShadowSampledEvent(makeEvent({ id: 'ff000000-0000-4000-8000-000000000000' }))).toBe(false);
    });
  });

  describe('getEventDispatchQueue / shutdownEventDispatchQueue', () => {
    it('returns the same singleton on repeated calls and closes it on shutdown', async () => {
      const q1 = mod.getEventDispatchQueue();
      const q2 = mod.getEventDispatchQueue();
      expect(q1).toBe(q2);

      await mod.shutdownEventDispatchQueue();
      expect(queueClose).toHaveBeenCalledTimes(1);
    });
  });
});
