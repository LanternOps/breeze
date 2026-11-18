import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #11427: the `wisp-wake` subscriber closes the concerns linked to a resolved
 * alert (`resolveConcernsForAlert`) BEFORE it requests the wake, so the
 * assessment the event triggers reads them closed. Best-effort: a failed close
 * never costs the wake. Dark while Wisp is disabled.
 */
const h = vi.hoisted(() => ({
  order: [] as string[],
  wispEnabled: vi.fn(() => true),
  resolveConcernsForAlert: vi.fn(),
  handleWispWakeEvent: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../workers/webhookDelivery', () => ({ configureWebhookFanout: vi.fn(), handleWebhookFanoutEvent: vi.fn() }));
vi.mock('./policyAlertBridge', () => ({ handlePolicyViolationEvent: vi.fn(), handlePolicyCompliantEvent: vi.fn() }));
vi.mock('./notificationDispatcher', () => ({ handleAlertLifecycleEvent: vi.fn() }));
vi.mock('./dnsThreatAlerts', () => ({ handleDnsThreatBlockedEvent: vi.fn() }));
vi.mock('../config/env', async (orig) => ({ ...(await orig<typeof import('../config/env')>()), wispEnabled: h.wispEnabled }));
vi.mock('./wisp/concerns', () => ({ resolveConcernsForAlert: h.resolveConcernsForAlert }));
vi.mock('./wisp/wake', () => ({ handleWispWakeEvent: h.handleWispWakeEvent }));
vi.mock('./sentry', () => ({ captureException: h.captureException }));

import { registerAllEventSubscribers } from './eventSubscribers';
import { _resetEventSubscriberRegistryForTests, getSubscriberById } from './eventSubscriberRegistry';
import type { BreezeEvent } from './eventBus';

const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ALERT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const event = (type: string, payload: Record<string, unknown> = {}): BreezeEvent =>
  ({ id: 'e1', type, orgId: ORG, payload, source: 'test', timestamp: new Date().toISOString(), priority: 'normal' }) as unknown as BreezeEvent;
const handler = () => getSubscriberById('wisp-wake')!.handler;

describe('wisp-wake subscriber: alert.resolved closes linked concerns first (#11427)', () => {
  beforeAll(() => {
    _resetEventSubscriberRegistryForTests();
    registerAllEventSubscribers({} as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    h.wispEnabled.mockReturnValue(true);
    h.resolveConcernsForAlert.mockImplementation(async () => { h.order.push('resolve'); return { resolved: 1 }; });
    h.handleWispWakeEvent.mockImplementation(async () => { h.order.push('wake'); });
  });

  it("resolves the alert's concerns in the event's org, then requests the wake", async () => {
    await handler()(event('alert.resolved', { alertId: ALERT }));
    expect(h.resolveConcernsForAlert).toHaveBeenCalledWith(ALERT, ORG);
    expect(h.order).toEqual(['resolve', 'wake']);
  });

  it('a failing close is reported and the wake still happens', async () => {
    h.resolveConcernsForAlert.mockRejectedValueOnce(new Error('db down'));
    await expect(handler()(event('alert.resolved', { alertId: ALERT }))).resolves.toBeUndefined();
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.handleWispWakeEvent).toHaveBeenCalledTimes(1);
  });

  it('other events, an alert.resolved without an alert id, and a disabled Wisp close nothing', async () => {
    await handler()(event('alert.triggered', { alertId: ALERT }));
    await handler()(event('alert.resolved', {}));
    h.wispEnabled.mockReturnValue(false);
    await handler()(event('alert.resolved', { alertId: ALERT }));
    expect(h.resolveConcernsForAlert).not.toHaveBeenCalled();
    expect(h.handleWispWakeEvent).toHaveBeenCalledTimes(3);
  });
});
