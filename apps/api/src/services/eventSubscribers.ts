// Registers the durable production event subscribers onto the registry
// (wave 3.5c, #4085; joined by the ticket-helpdesk subscriber, wave 6 PR 3,
// the anomaly-triggered admission subscriber, wave 6 PR 4, #3828, and the
// alert-verdict admission subscriber, Phase 2 wave P2-1 task 12). This
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
    id: 'ai-agent-alert-verdict',
    // Phase 2 wave P2-1 (alert verdicts), task 12. Admits a profile:'verdict'
    // run for a newly created alert correlation group (bound to the ROOT
    // alert's device) or a system/auto-resolved alert within the
    // auto-resolve window — see alertVerdictSubscriber.ts's header for the
    // full account.
    //
    // Task 13 extends this SAME subscriber (not a second id — controller
    // decision) with `alert.triggered`: an alert that stays open and
    // uncorrelated for UNGROUPED_VERDICT_DELAY_MINUTES also gets a verdict
    // run, via jobs/alertVerdictScheduler.ts's delayed BullMQ job. See that
    // module's header for the full account.
    //
    // Lazy, same reason and same pattern as ai-agent-anomaly below:
    // alertVerdictSubscriber.ts -> runService.ts's transitive closure
    // reaches routes/auth/schemas.ts (workerEntrypointClosure.contract.test.ts
    // caught this the first time a static import was tried here for the
    // ticket-helpdesk subscriber) — a dynamic import defers that cost to the
    // first alert.correlation_group.created/alert.resolved/alert.triggered
    // delivery instead of paying it at eventSubscribers.ts's module-eval time.
    eventTypes: ['alert.correlation_group.created', 'alert.resolved', 'alert.triggered'],
    handler: async (event: BreezeEvent) => {
      if (event.type === 'alert.triggered') {
        const { handleAlertTriggeredEvent } = await import('../jobs/alertVerdictScheduler');
        return handleAlertTriggeredEvent(event);
      }
      const { handleAlertVerdictEvent } = await import('./aiAgents/alertVerdictSubscriber');
      return handleAlertVerdictEvent(event);
    },
    retry: { attempts: 3, backoffMs: 30_000 },
  });

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
    // Phase 2 wave P2-4 (#4187/#4191) Task 9 extends this subscriber (not a
    // second id — same pattern as ai-agent-alert-verdict's task 13 note
    // above) to admit a triage run on `ticket.commented` (the ticket's
    // first genuinely-human comment) and `ticket.status_changed`
    // (resolution) in addition to `ticket.created` — see
    // ticketHelpdeskSubscriber.ts's header for the full per-event-type
    // admission rules.
    //
    // Lazy, same reason and same pattern as automation-worker below:
    // ticketHelpdeskSubscriber.ts -> runService.ts's transitive closure
    // reaches routes/auth/schemas.ts (workerEntrypointClosure.contract.test.ts
    // caught this on the first attempt at a static import here) — a dynamic
    // import defers that cost to the first ticket.created delivery instead
    // of paying it at eventSubscribers.ts's module-eval time.
    eventTypes: ['ticket.created', 'ticket.commented', 'ticket.status_changed'],
    handler: async (event: BreezeEvent) => {
      const {
        handleTicketCreatedEvent,
        handleTicketCommentedEvent,
        handleTicketStatusChangedEvent,
      } = await import('./aiAgents/ticketHelpdeskSubscriber');
      if (event.type === 'ticket.commented') return handleTicketCommentedEvent(event);
      if (event.type === 'ticket.status_changed') return handleTicketStatusChangedEvent(event);
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
