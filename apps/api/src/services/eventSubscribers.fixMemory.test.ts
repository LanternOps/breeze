import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * AI Suggested Fixes W1 (I5): the fix-memory subscribers run inline in
 * publishEvent (in-process dispatch) on a second pooled connection, so they
 * must subscribe to as little as possible. The outcome watcher is a latency
 * fast path only for alert.resolved; recurrence only matters at hold end, and
 * the 5-minute sweeper is authoritative for it.
 */
vi.mock('../workers/webhookDelivery', () => ({ configureWebhookFanout: vi.fn(), handleWebhookFanoutEvent: vi.fn() }));
vi.mock('./policyAlertBridge', () => ({ handlePolicyViolationEvent: vi.fn(), handlePolicyCompliantEvent: vi.fn() }));
vi.mock('./notificationDispatcher', () => ({ handleAlertLifecycleEvent: vi.fn() }));
vi.mock('./dnsThreatAlerts', () => ({ handleDnsThreatBlockedEvent: vi.fn() }));

import { registerAllEventSubscribers } from './eventSubscribers';
import { _resetEventSubscriberRegistryForTests, getSubscriberById } from './eventSubscriberRegistry';

describe('fix-memory event subscribers (I5)', () => {
  // registerAllEventSubscribers is idempotent per module instance: register once.
  beforeAll(() => {
    _resetEventSubscriberRegistryForTests();
    registerAllEventSubscribers({} as never);
  });

  it('fix-outcome-watcher subscribes to alert.resolved only — never alert.triggered', () => {
    expect(getSubscriberById('fix-outcome-watcher')?.eventTypes).toEqual(['alert.resolved']);
  });

  it('fix-memory-attach stays on alert.triggered', () => {
    expect(getSubscriberById('fix-memory-attach')?.eventTypes).toEqual(['alert.triggered']);
  });
});
