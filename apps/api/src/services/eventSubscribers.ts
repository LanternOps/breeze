// Registers the five production event subscribers onto the durable registry
// (wave 3.5c, #4085). This is the ONLY call site that should ever call
// `registerEventSubscriber` for these five ids — a subscriber that is both
// `subscribe()`d on the legacy bus AND registered here would fire twice (see
// eventSubscribers.contract.test.ts, which statically asserts none of the
// five production modules still calls `.subscribe(` on the global bus).
//
// `registerAllEventSubscribers` is synchronous and idempotence-guarded, and
// must be called from index.ts BEFORE `initializeWorkers()` — the queue-mode
// dispatch worker (and any event published during worker boot) must never be
// able to run ahead of the full registry being installed.
import { registerEventSubscriber } from './eventSubscriberRegistry';
import { EVENT_SUBSCRIBER_IDS } from './eventSubscriberIds';
import {
  configureWebhookFanout,
  handleWebhookFanoutEvent,
  type WebhookFanoutDeps,
} from '../workers/webhookDelivery';
import { handleAutomationEvent } from '../jobs/automationWorker';
import { handlePolicyViolationEvent, handlePolicyCompliantEvent } from './policyAlertBridge';
import { handleAlertLifecycleEvent } from './notificationDispatcher';
import { handleDnsThreatBlockedEvent } from './dnsThreatAlerts';
import type { BreezeEvent } from './eventBus';

let registered = false;

/**
 * Register all five durable event subscribers. Synchronous and idempotent —
 * a second call is a no-op (registerEventSubscriber itself throws on a
 * duplicate id, so this guard is what lets a hot-reload or a second import
 * of index.ts's bootstrap path not crash the process).
 */
export function registerAllEventSubscribers(deps: WebhookFanoutDeps): void {
  if (registered) {
    return;
  }
  registered = true;

  configureWebhookFanout(deps);

  registerEventSubscriber({
    id: 'webhook-delivery',
    eventTypes: '*',
    handler: handleWebhookFanoutEvent,
    retry: { attempts: 5, backoffMs: 10_000 },
  });

  registerEventSubscriber({
    id: 'automation-worker',
    eventTypes: '*',
    handler: handleAutomationEvent,
    retry: { attempts: 5, backoffMs: 10_000 },
  });

  registerEventSubscriber({
    id: 'notification-dispatcher',
    eventTypes: ['alert.triggered', 'alert.acknowledged', 'alert.resolved'],
    handler: handleAlertLifecycleEvent,
    retry: { attempts: 5, backoffMs: 10_000 },
  });

  registerEventSubscriber({
    id: 'policy-alert-bridge',
    eventTypes: ['policy.violation', 'policy.compliant'],
    handler: (event: BreezeEvent) => {
      if (event.type === 'policy.violation') return handlePolicyViolationEvent(event);
      if (event.type === 'policy.compliant') return handlePolicyCompliantEvent(event);
      return Promise.resolve();
    },
    retry: { attempts: 3, backoffMs: 30_000 },
  });

  registerEventSubscriber({
    id: 'dns-threat-alerts',
    eventTypes: ['dns.threat.blocked'],
    handler: handleDnsThreatBlockedEvent,
    retry: { attempts: 3, backoffMs: 30_000 },
  });
}

/** Test-only: allow a fresh test run to call registerAllEventSubscribers again. */
export function _resetEventSubscribersForTests(): void {
  registered = false;
}

// Referenced so a change to EVENT_SUBSCRIBER_IDS is at least visible here at
// review time; the exhaustive "every id registered exactly once" check lives
// in eventSubscribers.contract.test.ts (source-scan style).
export const _ALL_SUBSCRIBER_IDS = EVENT_SUBSCRIBER_IDS;
