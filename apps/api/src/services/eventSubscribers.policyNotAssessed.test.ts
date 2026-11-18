import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Strix (PR #12184): `policy.not_assessed` reaches the rule's owner through its
 * own durable subscriber. It must not ride on policy-alert-bridge: that
 * subscriber raises alerts, and a rule nobody could read is not a violation.
 */
const handleNotAssessed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../workers/webhookDelivery', () => ({ configureWebhookFanout: vi.fn(), handleWebhookFanoutEvent: vi.fn() }));
vi.mock('./policyAlertBridge', () => ({ handlePolicyViolationEvent: vi.fn(), handlePolicyCompliantEvent: vi.fn() }));
vi.mock('./notificationDispatcher', () => ({ handleAlertLifecycleEvent: vi.fn() }));
vi.mock('./dnsThreatAlerts', () => ({ handleDnsThreatBlockedEvent: vi.fn() }));
vi.mock('./policyNotAssessedNotice', () => ({ handlePolicyNotAssessedEvent: handleNotAssessed }));

import { registerAllEventSubscribers } from './eventSubscribers';
import { _resetEventSubscriberRegistryForTests, getSubscriberById } from './eventSubscriberRegistry';

describe('policy-not-assessed-notice subscriber', () => {
  beforeAll(() => {
    _resetEventSubscriberRegistryForTests();
    registerAllEventSubscribers({} as never);
  });

  it('subscribes to policy.not_assessed only', () => {
    expect(getSubscriberById('policy-not-assessed-notice')?.eventTypes).toEqual(['policy.not_assessed']);
  });

  it('hands the event to the notice handler', async () => {
    const event = { type: 'policy.not_assessed', orgId: 'org-1', payload: {} } as never;
    await getSubscriberById('policy-not-assessed-notice')!.handler(event);
    expect(handleNotAssessed).toHaveBeenCalledWith(event);
  });

  it('the alert bridge does not take it', () => {
    expect(getSubscriberById('policy-alert-bridge')?.eventTypes).not.toContain('policy.not_assessed');
  });
});
