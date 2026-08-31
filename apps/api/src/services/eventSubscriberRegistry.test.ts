import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerEventSubscriber,
  getRegisteredSubscribers,
  subscribersMatching,
  partitionSubscribersForEvent,
  getSubscriberById,
  _resetEventSubscriberRegistryForTests,
  type DurableEventSubscriber,
} from './eventSubscriberRegistry';
import type { EventType } from './eventBus';

function sub(
  id: DurableEventSubscriber['id'],
  eventTypes: DurableEventSubscriber['eventTypes'] = '*',
): DurableEventSubscriber {
  return {
    id,
    eventTypes,
    handler: vi.fn().mockResolvedValue(undefined),
  };
}

describe('eventSubscriberRegistry', () => {
  beforeEach(() => {
    _resetEventSubscriberRegistryForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers a subscriber and returns it by id', () => {
    const s = sub('webhook-delivery', ['device.enrolled']);
    registerEventSubscriber(s);

    expect(getSubscriberById('webhook-delivery')).toBe(s);
    expect(getRegisteredSubscribers()).toEqual([s]);
  });

  it('throws on duplicate id registration', () => {
    registerEventSubscriber(sub('webhook-delivery'));

    expect(() => registerEventSubscriber(sub('webhook-delivery'))).toThrow(
      'duplicate event subscriber id: webhook-delivery',
    );
  });

  describe('subscribersMatching', () => {
    it('returns wildcard subscribers for every type plus exact matches, sorted by id', () => {
      const wildcardB = sub('policy-alert-bridge', '*');
      const wildcardA = sub('automation-worker', '*');
      const exact = sub('webhook-delivery', ['device.enrolled']);
      const unrelated = sub('dns-threat-alerts', ['dns.threat.blocked']);

      // Register out of alphabetical order to prove sorting isn't incidental.
      registerEventSubscriber(wildcardB);
      registerEventSubscriber(exact);
      registerEventSubscriber(wildcardA);
      registerEventSubscriber(unrelated);

      const matched = subscribersMatching('device.enrolled' as EventType);

      expect(matched.map((s) => s.id)).toEqual([
        'automation-worker',
        'policy-alert-bridge',
        'webhook-delivery',
      ]);
    });

    it('returns an empty array when nothing matches', () => {
      registerEventSubscriber(sub('dns-threat-alerts', ['dns.threat.blocked']));

      expect(subscribersMatching('device.enrolled' as EventType)).toEqual([]);
    });
  });

  describe('partitionSubscribersForEvent', () => {
    it('puts everything matched into local when mode is off', () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'off');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery');
      const s = sub('webhook-delivery', ['device.enrolled']);
      registerEventSubscriber(s);

      const result = partitionSubscribersForEvent('device.enrolled' as EventType);

      expect(result.matched).toEqual(['webhook-delivery']);
      expect(result.local).toEqual([s]);
      expect(result.queue).toEqual([]);
    });

    it('puts everything matched into local when mode is shadow', () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery');
      const s = sub('webhook-delivery', ['device.enrolled']);
      registerEventSubscriber(s);

      const result = partitionSubscribersForEvent('device.enrolled' as EventType);

      expect(result.matched).toEqual(['webhook-delivery']);
      expect(result.local).toEqual([s]);
      expect(result.queue).toEqual([]);
    });

    it('in enforce mode, a queue-listed matched subscriber lands in queue and NOT local', () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery');
      const queued = sub('webhook-delivery', ['device.enrolled']);
      const notQueued = sub('automation-worker', ['device.enrolled']);
      registerEventSubscriber(queued);
      registerEventSubscriber(notQueued);

      const result = partitionSubscribersForEvent('device.enrolled' as EventType);

      expect(result.matched.sort()).toEqual(['automation-worker', 'webhook-delivery']);
      expect(result.queue).toEqual([queued]);
      expect(result.local).toEqual([notQueued]);

      // Disjointness / union invariant — the core correctness property.
      const localIds = new Set(result.local.map((s) => s.id));
      const queueIds = new Set(result.queue.map((s) => s.id));
      for (const id of localIds) expect(queueIds.has(id)).toBe(false);
      const unionIds = new Set([...localIds, ...queueIds]);
      expect(unionIds).toEqual(new Set(result.matched));
    });

    it('an id in the queue csv that does not match the event type appears in neither local nor queue', () => {
      vi.stubEnv('EVENT_DISPATCH_MODE', 'enforce');
      vi.stubEnv('EVENT_DISPATCH_QUEUE_SUBSCRIBERS', 'webhook-delivery');
      // webhook-delivery only matches device.enrolled, not dns.threat.blocked
      registerEventSubscriber(sub('webhook-delivery', ['device.enrolled']));

      const result = partitionSubscribersForEvent('dns.threat.blocked' as EventType);

      expect(result.matched).toEqual([]);
      expect(result.local).toEqual([]);
      expect(result.queue).toEqual([]);
    });
  });
});
