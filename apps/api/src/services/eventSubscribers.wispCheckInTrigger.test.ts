import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W04 (#11493, #10410): the `wisp-check-in-trigger` subscriber is the event
 * fast path of event check-ins. It is its own id, apart from `wisp-wake`, so
 * the assessment wake never sees `device.online`; its event types are exactly
 * the ones the handler maps to a trigger kind; the handler is lazy and its
 * throw propagates (the subscriber contract), so a failed delivery retries.
 */
const h = vi.hoisted(() => ({ handleCheckInTriggerEvent: vi.fn() }));

vi.mock('../workers/webhookDelivery', () => ({ configureWebhookFanout: vi.fn(), handleWebhookFanoutEvent: vi.fn() }));
vi.mock('./policyAlertBridge', () => ({ handlePolicyViolationEvent: vi.fn(), handlePolicyCompliantEvent: vi.fn() }));
vi.mock('./notificationDispatcher', () => ({ handleAlertLifecycleEvent: vi.fn() }));
vi.mock('./dnsThreatAlerts', () => ({ handleDnsThreatBlockedEvent: vi.fn() }));
vi.mock('./wisp/checkIns', async (orig) => ({
  ...(await orig<typeof import('./wisp/checkIns')>()),
  handleCheckInTriggerEvent: h.handleCheckInTriggerEvent,
}));

import { registerAllEventSubscribers } from './eventSubscribers';
import { _resetEventSubscriberRegistryForTests, getSubscriberById } from './eventSubscriberRegistry';
import { CHECK_IN_TRIGGER_EVENT_SUBJECTS } from './wisp/checkIns';
import type { BreezeEvent } from './eventBus';

const event = (type: string, payload: Record<string, unknown> = {}): BreezeEvent =>
  ({ id: 'e1', type, orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', payload, source: 'test', timestamp: new Date().toISOString(), priority: 'normal' }) as unknown as BreezeEvent;

describe('wisp-check-in-trigger subscriber (W04)', () => {
  beforeAll(() => {
    _resetEventSubscriberRegistryForTests();
    registerAllEventSubscribers({} as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.handleCheckInTriggerEvent.mockResolvedValue(undefined);
  });

  it('subscribes to exactly the event types the handler maps to a trigger', () => {
    const sub = getSubscriberById('wisp-check-in-trigger')!;
    expect(sub).toBeDefined();
    expect([...(sub.eventTypes as readonly string[])].sort()).toEqual(Object.keys(CHECK_IN_TRIGGER_EVENT_SUBJECTS).sort());
    expect([...(sub.eventTypes as readonly string[])].sort()).toEqual([
      'ai.agent.run.completed', 'ai.agent.run.failed', 'ai.agent.run.skipped', 'device.online', 'script.completed', 'script.failed',
    ]);
    expect(sub.retry).toEqual({ attempts: 3, backoffMs: 30_000 });
  });

  it('maps each event to its trigger kind and payload id', () => {
    expect(CHECK_IN_TRIGGER_EVENT_SUBJECTS).toEqual({
      'device.online': { kind: 'device_online', idKey: 'deviceId' },
      'script.completed': { kind: 'script_finished', idKey: 'executionId' },
      'script.failed': { kind: 'script_finished', idKey: 'executionId' },
      'ai.agent.run.completed': { kind: 'run_settled', idKey: 'runId' },
      'ai.agent.run.failed': { kind: 'run_settled', idKey: 'runId' },
      'ai.agent.run.skipped': { kind: 'run_settled', idKey: 'runId' },
    });
  });

  it('the assessment wake never sees device.online', () => {
    expect(getSubscriberById('wisp-wake')!.eventTypes).not.toContain('device.online');
  });

  it('hands the event to handleCheckInTriggerEvent and lets its failure propagate', async () => {
    const e = event('device.online', { deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    await getSubscriberById('wisp-check-in-trigger')!.handler(e);
    expect(h.handleCheckInTriggerEvent).toHaveBeenCalledWith(e);
    h.handleCheckInTriggerEvent.mockRejectedValueOnce(new Error('db down'));
    await expect(getSubscriberById('wisp-check-in-trigger')!.handler(e)).rejects.toThrow('db down');
  });
});
