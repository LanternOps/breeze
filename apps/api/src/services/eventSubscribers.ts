// Registers the durable production event subscribers onto the registry
// (wave 3.5c, #4085; joined by the ticket-helpdesk subscriber, wave 6 PR 3,
// and the anomaly-triggered admission subscriber, wave 6 PR 4, #3828). This
// is the ONLY call site that should ever call
// `registerEventSubscriber` for these ids — a subscriber that is both
// `subscribe()`d on the legacy bus AND registered here would fire twice (see
// eventSubscribers.contract.test.ts, which statically asserts none of the
// five original production modules still calls `.subscribe(` on the global
// bus — `ticketHelpdeskSubscriber.ts` never existed on the legacy bus, so it
// is outside that particular assertion's scope, but is covered by the
// registration-count checks below it in the same file).
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
import { handlePolicyViolationEvent, handlePolicyCompliantEvent } from './policyAlertBridge';
import { handleAlertLifecycleEvent } from './notificationDispatcher';
import { handleDnsThreatBlockedEvent } from './dnsThreatAlerts';
import type { BreezeEvent } from './eventBus';

let registered = false;

/**
 * Register all durable event subscribers. Synchronous and idempotent —
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
    id: 'ai-agent-anomaly',
    // v1 scope: admission is triggered on anomaly.incident_opened only —
    // Task 2's metricAnomalyIncidentPublisher.ts is the only publisher of
    // this event type.
    //
    // Lazy, same reason and same pattern as ai-agent-ticket-helpdesk below:
    // metricAnomalySubscriber.ts -> runService.ts's transitive closure
    // reaches routes/auth/schemas.ts (workerEntrypointClosure.contract.test.ts
    // caught this the first time a static import was tried here for the
    // ticket-helpdesk subscriber) — a dynamic import defers that cost to the
    // first anomaly.incident_opened delivery instead of paying it at
    // eventSubscribers.ts's module-eval time.
    eventTypes: ['anomaly.incident_opened'],
    handler: async (event: BreezeEvent) => {
      const { handleAnomalyIncidentOpenedEvent } = await import('./aiAgents/metricAnomalySubscriber');
      return handleAnomalyIncidentOpenedEvent(event);
    },
    retry: { attempts: 5, backoffMs: 10_000 },
  });

  registerEventSubscriber({
    id: 'webhook-delivery',
    eventTypes: '*',
    handler: handleWebhookFanoutEvent,
    retry: { attempts: 5, backoffMs: 10_000 },
  });

  registerEventSubscriber({
    id: 'ai-agent-ticket-helpdesk',
    // v1 scope: admission is triggered on ticket.created only —
    // ticket.commented/ticket.status_changed are on the bus for future
    // context/admission use but not read here yet (see the plan's deferred
    // items).
    //
    // Lazy, same reason and same pattern as automation-worker below:
    // ticketHelpdeskSubscriber.ts -> runService.ts's transitive closure
    // reaches routes/auth/schemas.ts (workerEntrypointClosure.contract.test.ts
    // caught this on the first attempt at a static import here) — a dynamic
    // import defers that cost to the first ticket.created delivery instead
    // of paying it at eventSubscribers.ts's module-eval time.
    eventTypes: ['ticket.created'],
    handler: async (event: BreezeEvent) => {
      const { handleTicketCreatedEvent } = await import('./aiAgents/ticketHelpdeskSubscriber');
      return handleTicketCreatedEvent(event);
    },
    retry: { attempts: 5, backoffMs: 10_000 },
  });

  registerEventSubscriber({
    id: 'automation-worker',
    eventTypes: '*',
    // Lazy: jobs/automationWorker.ts is one of two static edges that pull the
    // whole route graph (incl. routes/agentWs.ts, via
    // automationRuntime -> scriptDispatch) into the worker boot closure — see
    // workerEntrypointClosure.contract.test.ts. A dynamic import here means
    // this module is only loaded (and its route-reaching chain only
    // traversed) the first time an automation event actually fires, not at
    // eventSubscribers.ts's module-eval time.
    handler: async (event: BreezeEvent) => {
      const { handleAutomationEvent } = await import('../jobs/automationWorker');
      return handleAutomationEvent(event);
    },
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
