import Redis from 'ioredis';
import { getRedisConnection } from './redis';
import { randomUUID } from 'crypto';
import { runOutsideDbContext } from '../db';
import { captureException } from './sentry';
import { partitionSubscribersForEvent } from './eventSubscriberRegistry';
import { eventDispatchMode } from '../config/env';
import { enqueueRouteEvent, recordShadowLocalInvocation } from './eventDispatchQueue';

// Event types for type safety
export type EventType =
  // Device events
  | 'device.enrolled'
  | 'device.online'
  | 'device.offline'
  | 'device.updated'
  | 'device.decommissioned'
  | 'device.main_agent_silent' // #800: watchdog OK, main agent silent
  // Alert events
  | 'alert.triggered'
  | 'alert.acknowledged'
  // C2 fix (P2-1 wave B, task 16d): every publisher SHOULD include
  // `resolvedAt` (ISO string), `resolvedBy` (uuid | null — null means a
  // system/auto resolve), and `triggeredAt` (ISO string) on the payload,
  // sourced from the row the publisher's own UPDATE just wrote/returned —
  // never from a second read. This lets a subscriber (see
  // `alertVerdictSubscriber.ts`'s contract comment) gate on the PUBLISHED
  // payload instead of re-reading the alert row, which can be stale when
  // the publisher runs inside a still-open transaction (the auto-resolve
  // sweep in `jobs/alertWorker.ts` / `jobs/monitorWorker.ts` publishes
  // before its wrapping `withSystemDbAccessContext` commits). A publisher
  // that omits these fields falls back to the pre-existing re-read
  // behavior — not every one currently sets them, but new ones should.
  | 'alert.resolved'
  | 'alert.suppressed'
  | 'alert.escalated'
  // Alert correlation group events (P2-1 wave B task 11). Published by
  // jobs/alertCorrelation.ts after persistAlertCorrelationGroupsForAlerts
  // returns — once per NEWLY created alert_correlation_groups row (never on
  // re-upsert of an existing group; xmax = 0 on the RETURNING row is what
  // distinguishes the two). Task 16e fix: the worker DOES run inside an
  // enclosing transaction (`withSystemDbAccessContext`, via `db/index.ts`'s
  // `withDbAccessContext` -> `baseDb.transaction`) — the premise this
  // comment used to state ("no enclosing transaction") was disproved by two
  // FK-violation reproductions (see `jobs/alertCorrelation.ts`'s F1-fix
  // comment). `processAlertCorrelationJob` publishes this event only AFTER
  // that `withSystemDbAccessContext` promise has resolved, i.e. once the
  // transaction has committed and the row is durably visible.
  //
  // General contract for every publisher in this file: publish OUTSIDE the
  // DB context that wrote the row (after commit, never from inside an
  // open transaction), and a subscriber must never re-read that row on its
  // own connection and trust it over the published payload — a re-read can
  // still race a DIFFERENT publisher's still-open transaction (the
  // auto-resolve sweep in `jobs/alertWorker.ts` / `jobs/monitorWorker.ts`
  // publishes `alert.resolved` before its own `withSystemDbAccessContext`
  // commits — see the `alert.resolved` comment above and
  // `alertVerdictSubscriber.ts`'s payload-gating contract). Payload is
  // { groupId, rootAlertId, memberCount, deviceId } — rootAlertId/deviceId
  // are both null when the root alert has since been hard-deleted
  // (alert_correlation_groups.root_alert_id is ON DELETE SET NULL).
  | 'alert.correlation_group.created'
  // Incident events
  | 'incident.created'
  | 'incident.contained'
  | 'incident.escalated'
  | 'incident.closed'
  // Script events
  | 'script.started'
  | 'script.completed'
  | 'script.failed'
  // Automation events
  | 'automation.started'
  | 'automation.completed'
  | 'automation.failed'
  // Policy events
  | 'policy.evaluated'
  | 'policy.violation'
  | 'policy.compliant'
  | 'policy.remediation.triggered'
  // Audit baseline compliance events
  | 'compliance.audit_deviation'
  | 'compliance.audit_remediated'
  // Patch events
  | 'patch.available'
  | 'patch.approved'
  | 'patch.installed'
  | 'patch.failed'
  | 'patch.rollback'
  // Vulnerability events (BE-16)
  | 'vulnerability.critical_detected'
  | 'vulnerability.remediation_scheduled'
  | 'vulnerability.remediated'
  // Backup verification events
  | 'backup.verification_failed'
  | 'backup.verification_passed'
  | 'backup.recovery_readiness_low'
  // Backup SLA events
  | 'backup.sla_breach'
  | 'backup.sla_resolved'
  // Ticket SLA events (Phase 2, ticketSlaWorker)
  | 'ticket.sla_breached'
  // Ticket lifecycle events (#3828 wave-6-3 task 2). Published by
  // ticketOutboxPublisher.ts from the ticket_outbox transactional outbox —
  // id-only payloads (never subject/description/resolutionNote/comment
  // content), same posture as ticket.sla_breached's `assigneeId`-only shape
  // but stricter (that event predates the id-only design authority). Consumed
  // by the Task 3 durable ticket-helpdesk subscriber (ticket.created only, v1)
  // — ticket.commented/ticket.status_changed are published for future
  // admission scope (deferred; see the wave-6-3 plan's Self-Review Notes).
  | 'ticket.created'
  | 'ticket.commented'
  | 'ticket.status_changed'
  // Metric-anomaly incident events (#3828 wave-6-4 task 2). Published by
  // metricAnomalyIncidentPublisher.ts from the metric_anomaly_incidents
  // transactional dispatch marker (never re-published on re-upsert — see
  // that table's file header). Id-only payload: { incidentId, deviceId }.
  // Consumed by the Task 3 durable metric-anomaly subscriber.
  | 'anomaly.incident_opened'
  // Security events
  | 'security.score_changed'
  // CIS compliance events
  | 'compliance.cis_deviation'
  | 'compliance.cis_score_changed'
  | 'compliance.cis_remediation_applied'
  | 's1.threat_detected'
  | 's1.device_isolated'
  | 's1.threat_action_completed'
  | 'huntress.incident_created'
  | 'huntress.incident_updated'
  | 'huntress.agent_offline'
  | 'compliance.sensitive_data_found'
  | 'compliance.credential_exposed'
  | 'compliance.sensitive_data_remediated'
  // DNS Security events (#829)
  | 'dns.threat.blocked'
  // Browser security events
  | 'compliance.browser_policy_applied'
  // Peripheral control events
  | 'peripheral.unauthorized_device'
  | 'peripheral.blocked'
  | 'peripheral.policy_changed'
  // Remote events
  | 'remote.session.started'
  | 'remote.session.ended'
  // User events
  | 'user.login'
  | 'user.logout'
  | 'user.mfa.enabled'
  | 'user.risk_score_high'
  | 'user.risk_score_spike'
  | 'user.training_assigned'
  // Device user-session events (BE-8)
  | 'session.login'
  | 'session.logout'
  // Service & process monitoring events
  | 'monitoring.check_failed'
  | 'monitoring.check_recovered'
  // PAM elevation lifecycle events (#1163). Consumed by the /pam admin UI
  // (#1159) via the events WS and by the Brain context feed (#1160).
  | 'elevation.requested'
  | 'elevation.auto_approved'
  | 'elevation.approved'
  | 'elevation.denied'
  | 'elevation.activated'
  | 'elevation.expired'
  | 'elevation.revoked'
  // AI operator agents (spec 2026-08-22 §7). Wave 1 publishes policy_changed;
  // the run.* members are reserved for the wave-3 runner.
  | 'ai.agent.policy_changed'
  | 'ai.agent.run.queued'
  | 'ai.agent.run.started'
  | 'ai.agent.run.awaiting_approval'
  | 'ai.agent.run.completed'
  | 'ai.agent.run.failed'
  | 'ai.agent.run.skipped'
  // #4205 — follow-up to #3828/PR #4168: the per-org circuit breaker
  // (`agentCircuit.ts`'s `recordRunTerminal`) previously only fired a
  // notification + audit row when it opened. Published from the SAME
  // best-effort, outside-the-transaction fan-out as those two, right after
  // the CAS-guarded open-transition UPDATE commits — so it shares their
  // "opens exactly once per episode" guarantee. Payload:
  // { agentId, orgId, triggeringRunId, consecutiveFailures, threshold }.
  | 'ai.agent.circuit.opened'
  // #4388 — an org crossed an AI budget rung; org-level, no device/site.
  | 'ai.budget.threshold_crossed'
  // Wave 2 (#3823). Addressed to ONE user, never broadcast — see
  // publishUserEvent, which deliberately does not use the ordinary publish
  // path. Two segments so it stays subscribable under EVENT_TYPE_RE.
  | 'notification.created';

export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export interface BreezeEvent<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  orgId: string;
  /**
   * When set, this event is addressed to exactly one user and the WS layer must
   * deliver it to that user alone. Only ever set by publishUserEvent.
   */
  audienceUserId?: string;
  /**
   * Site this event is attributable to, when known. Used by the events WS
   * layer to deliver in-site events to site-restricted users (the app-layer
   * SITE-scope axis; RLS only enforces ORG). See `buildSiteFilter` in
   * `routes/eventWs.ts`, which fails closed when no `siteId` is present.
   *
   * Omitted for genuinely org-level events with no site context. The WS filter
   * treats a missing `siteId` as "not deliverable to a site-restricted user"
   * (fail-closed) — unrestricted users are unaffected either way. Device-scoped
   * publishers should set this whenever the device's site is cheaply available.
   */
  siteId?: string;
  source: string;
  priority: EventPriority;
  payload: T;
  metadata: {
    correlationId?: string;
    causationId?: string;
    userId?: string;
    timestamp: string;
  };
}

export interface PublishOptions {
  /** Stable logical identity for a durable publisher; retries may physically redeliver. */
  eventId?: string;
  /** Immutable source timestamp for durable publication retries. */
  occurredAt?: string;
  priority?: EventPriority;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  /**
   * Site this event is attributable to. Surfaces as a top-level `siteId` on the
   * published `BreezeEvent` so the events-WS site filter can deliver it to
   * site-restricted users. Pass it whenever the originating device's site is
   * known. `null`/`undefined` ⇒ org-level (no site attribution).
   */
  siteId?: string | null;
}

export type EventHandler<T = Record<string, unknown>> = (event: BreezeEvent<T>) => Promise<void>;

// Stream key pattern: breeze:events:{orgId}
const STREAM_PREFIX = 'breeze:events';
const MAX_STREAM_LENGTH = 10000; // Trim streams to prevent unbounded growth

/**
 * EventBus - Redis Streams + pub/sub based event system.
 *
 * Features:
 * - Durable event log via Redis Streams (XADD, MAXLEN-capped)
 * - Real-time delivery via pub/sub (org-scoped live channel + global channel)
 * - Correlation ID tracking for distributed tracing
 * - Priority-based routing
 */
class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private redisClient: Redis | null = null;

  /**
   * Get or create a persistent Redis connection for the EventBus.
   * Reuses the same connection across all operations to prevent leaks.
   */
  private getOrCreateRedis(): Redis {
    if (this.redisClient && this.redisClient.status !== 'end') {
      return this.redisClient;
    }
    this.redisClient = getRedisConnection();
    return this.redisClient;
  }

  /**
   * Release this bus's reference to the shared Redis connection.
   *
   * Deliberately does NOT call `.quit()`: `getOrCreateRedis()` borrows the
   * module-singleton BullMQ connection (`getRedisConnection()`), which every
   * BullMQ Worker/Queue in the process shares. Quitting it here tore the
   * connection out from under consumers still draining in the same shutdown
   * pass — `closeRedis()` is the sole owner of that quit (wave 3.5d-a, #4086).
   */
  async close(): Promise<void> {
    this.redisClient = null;
  }

  /**
   * Publish an event to the event bus
   */
  async publish<T = Record<string, unknown>>(
    type: EventType,
    orgId: string,
    payload: T,
    source: string,
    options: PublishOptions = {}
  ): Promise<string> {
    const eventId = options.eventId ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
      throw new Error('Invalid eventId');
    }
    const occurredAt = options.occurredAt === undefined ? new Date() : new Date(options.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new Error('Invalid occurredAt');
    const streamKey = `${STREAM_PREFIX}:${orgId}`;

    // Normalise an empty-string siteId to "no attribution" so the WS filter
    // never matches against a blank id.
    const siteId =
      typeof options.siteId === 'string' && options.siteId.length > 0 ? options.siteId : undefined;

    const event: BreezeEvent<T> = {
      id: eventId,
      type,
      orgId,
      ...(siteId ? { siteId } : {}),
      source,
      priority: options.priority || 'normal',
      payload,
      metadata: {
        correlationId: options.correlationId || eventId,
        causationId: options.causationId,
        userId: options.userId,
        timestamp: occurredAt.toISOString()
      }
    };

    // Escape any active AsyncLocalStorage DB transaction context before doing
    // Redis-bound work. Otherwise a publishEvent call made from inside a
    // transaction (e.g. alertWorker, createAlert, publishEvent) holds the
    // Postgres connection in `idle in transaction` for as long as Redis takes.
    // Any local handler (e.g. webhookDelivery / automationWorker `*`
    // subscribers that queue BullMQ deliveries) compounds that wait. Under a
    // Redis stall this manifested as Postgres pool exhaustion and login
    // lockout on 2026-05-21.
    return runOutsideDbContext(async () => {
      const redis = this.getOrCreateRedis();

      // Add to Redis Stream
      await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        MAX_STREAM_LENGTH.toString(),
        '*',
        'event',
        JSON.stringify(event)
      );

      // Also publish to pub/sub for real-time subscribers
      await redis.publish(`${STREAM_PREFIX}:live:${orgId}`, JSON.stringify(event));

      // Publish to global channel for cross-org subscribers (webhooks, etc.)
      await redis.publish(`${STREAM_PREFIX}:global`, JSON.stringify(event));

      if (type !== 'monitoring.check_failed' && type !== 'monitoring.check_recovered') {
        console.log(`[EventBus] Published ${type} for org ${orgId}: ${eventId}`);
      }

      // Dispatch-queue ingress (wave 3.5c, #4085): snapshot the publisher's
      // routing plan into a durable BullMQ job BEFORE running local handlers,
      // so the snapshot survives even if this process crashes mid-handler.
      // `off` (the default) skips this entirely — today's in-process-only
      // delivery is unchanged. enqueueRouteEvent itself never throws.
      const dispatchMode = eventDispatchMode();
      if (dispatchMode !== 'off') {
        await enqueueRouteEvent(event as BreezeEvent);
      }

      // Invoke local in-process handlers immediately (this is the only
      // delivery path — there is no consumer-group replay of the stream).
      await this.invokeLocalHandlers(event as BreezeEvent);

      return eventId;
    });
  }

  /**
   * Publish an event addressed to ONE user.
   *
   * This deliberately does NOT go through `publish()`. That path also writes
   * the org's Redis STREAM (persisted, MAXLEN-capped), the GLOBAL cross-org
   * channel that webhook delivery subscribes to, and every local wildcard
   * handler (webhookDelivery, automationWorker). A private notification taking
   * that route would be persisted for anything reading the stream, could be
   * forwarded to a customer's webhook endpoint, and could trigger automations
   * — none of which the recipient consented to.
   *
   * So this writes exactly one thing: the live pub/sub channel the WS
   * dispatcher reads. The transport is still org-wide (that is how the
   * dispatcher is built), which is why the payload must stay CONTENT-FREE — a
   * notification id and nothing else. The client refetches through
   * GET /notifications, which is behind RLS. That way the filter is not the
   * only thing standing between one user's notification and another's screen:
   * even a mis-delivered event carries nothing worth having.
   */
  async publishUserEvent(
    type: EventType,
    orgId: string,
    audienceUserId: string,
    payload: Record<string, unknown>,
    source: string,
  ): Promise<string> {
    const eventId = randomUUID();
    const event: BreezeEvent = {
      id: eventId,
      type,
      orgId,
      audienceUserId,
      source,
      priority: 'normal',
      payload,
      metadata: {
        correlationId: eventId,
        timestamp: new Date().toISOString(),
      },
    };

    // Same reason as publish(): never hold a Postgres transaction open across
    // Redis-bound work.
    return runOutsideDbContext(async () => {
      const redis = this.getOrCreateRedis();
      await redis.publish(`${STREAM_PREFIX}:live:${orgId}`, JSON.stringify(event));
      return eventId;
    });
  }

  /**
   * Invoke local in-process handlers for an event
   * Called when publishing to handle local subscribers immediately.
   *
   * Failures here are swallowed (not rethrown) so one buggy subscriber
   * can't take down the publishEvent path — the BullMQ subscribers in
   * webhookDelivery.ts and automationWorker.ts depend on this. The
   * tradeoff is silent failure of e.g. a dropped delivery enqueue, so
   * each failure is emitted as a structured log line (JSON-shaped via
   * console.error) that carries enough context (event.id, event.orgId,
   * event.source, event.type, handler index) to be searchable by an
   * operator and pulled into ops dashboards. See issue #820.
   */
  private async invokeLocalHandlers(event: BreezeEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type) || new Set();
    const wildcardHandlers = this.handlers.get('*') || new Set();
    const allHandlers = [...typeHandlers, ...wildcardHandlers];

    let handlerIndex = 0;
    for (const handler of allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        // Structured shape so ops can grep / aggregate / forward to a
        // log aggregator. Keep using console.error rather than throw so
        // a single failing subscriber doesn't stop the publish loop.
        console.error(
          '[EventBus] local-handler-failed',
          JSON.stringify({
            errorId: 'EVENT_BUS_LOCAL_HANDLER_FAILED',
            eventId: event.id,
            eventType: event.type,
            orgId: event.orgId,
            source: event.source,
            handlerIndex,
            error: err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : String(err),
          }),
        );
      }
      handlerIndex += 1;
    }

    // Registry-aware local delivery (wave 3.5c, #4085). Subscribers registered
    // via `registerEventSubscriber` (the replacement for the legacy `subscribe`
    // map above) are routed through `partitionSubscribersForEvent`, which keeps
    // this in-process path and the queue path (eventDispatchWorker) mutually
    // exclusive in `enforce` mode.
    const { local } = partitionSubscribersForEvent(event.type);
    for (const sub of local) {
      try {
        await sub.handler(event);
        // Shadow-mode bookkeeping (wave 3.5c, #4085): fire-and-forget — a
        // Redis hiccup recording shadow stats must never affect delivery.
        // No-ops entirely outside shadow mode (see recordShadowLocalInvocation).
        recordShadowLocalInvocation(event, sub.id, 'ok').catch((err) => {
          console.warn('[EventBus] shadow-record-failed', err);
        });
      } catch (error) {
        // Local delivery keeps wave-3d semantics: a buggy subscriber must not
        // break the publish path (#820). Queue delivery (eventDispatchWorker)
        // deliberately does NOT catch — the throw drives BullMQ retries.
        console.error(
          '[EventBus] local-handler-failed',
          JSON.stringify({
            errorId: 'EVENT_BUS_LOCAL_HANDLER_FAILED',
            eventId: event.id,
            eventType: event.type,
            orgId: event.orgId,
            source: event.source,
            subscriberId: sub.id,
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
          }),
        );
        try {
          captureException(error); // NEW — five of six subscribers were stdout-only
        } catch {
          // Sentry must never break publish() — a throwing captureException
          // (e.g. a misconfigured SDK) would otherwise escape this catch and
          // reject publish() for the caller. See the carried fix, #4085 task 5.
        }
        recordShadowLocalInvocation(event, sub.id, 'error').catch((err) => {
          console.warn('[EventBus] shadow-record-failed', err);
        });
      }
    }
  }

  /**
   * Subscribe to events of a specific type
   */
  subscribe<T = Record<string, unknown>>(
    eventType: EventType | '*',
    handler: EventHandler<T>
  ): () => void {
    const key = eventType;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(key)?.delete(handler as EventHandler);
    };
  }

}

// Singleton instance
let eventBusInstance: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!eventBusInstance) {
    eventBusInstance = new EventBus();
  }
  return eventBusInstance;
}

// Convenience function for publishing events
export async function publishEvent<T = Record<string, unknown>>(
  type: EventType,
  orgId: string,
  payload: T,
  source: string,
  options?: PublishOptions
): Promise<string> {
  return getEventBus().publish(type, orgId, payload, source, options);
}

// Export event types for consumers
export const EVENT_TYPES = {
  // Device
  DEVICE_ENROLLED: 'device.enrolled' as const,
  DEVICE_ONLINE: 'device.online' as const,
  DEVICE_OFFLINE: 'device.offline' as const,
  DEVICE_UPDATED: 'device.updated' as const,
  DEVICE_DECOMMISSIONED: 'device.decommissioned' as const,
  // #800: server-detected asymmetry (watchdog OK, main agent silent past threshold)
  DEVICE_MAIN_AGENT_SILENT: 'device.main_agent_silent' as const,
  // Alert
  ALERT_TRIGGERED: 'alert.triggered' as const,
  ALERT_ACKNOWLEDGED: 'alert.acknowledged' as const,
  ALERT_RESOLVED: 'alert.resolved' as const,
  ALERT_SUPPRESSED: 'alert.suppressed' as const,
  ALERT_ESCALATED: 'alert.escalated' as const,
  // Alert correlation group (P2-1 wave B task 11)
  ALERT_CORRELATION_GROUP_CREATED: 'alert.correlation_group.created' as const,
  // Incident
  INCIDENT_CREATED: 'incident.created' as const,
  INCIDENT_CONTAINED: 'incident.contained' as const,
  INCIDENT_ESCALATED: 'incident.escalated' as const,
  INCIDENT_CLOSED: 'incident.closed' as const,
  // Script
  SCRIPT_STARTED: 'script.started' as const,
  SCRIPT_COMPLETED: 'script.completed' as const,
  SCRIPT_FAILED: 'script.failed' as const,
  // Automation
  AUTOMATION_STARTED: 'automation.started' as const,
  AUTOMATION_COMPLETED: 'automation.completed' as const,
  AUTOMATION_FAILED: 'automation.failed' as const,
  // Policy
  POLICY_EVALUATED: 'policy.evaluated' as const,
  POLICY_VIOLATION: 'policy.violation' as const,
  POLICY_COMPLIANT: 'policy.compliant' as const,
  POLICY_REMEDIATION_TRIGGERED: 'policy.remediation.triggered' as const,
  // Patch
  PATCH_AVAILABLE: 'patch.available' as const,
  PATCH_APPROVED: 'patch.approved' as const,
  PATCH_INSTALLED: 'patch.installed' as const,
  PATCH_FAILED: 'patch.failed' as const,
  PATCH_ROLLBACK: 'patch.rollback' as const,
  // Vulnerability (BE-16)
  VULNERABILITY_CRITICAL_DETECTED: 'vulnerability.critical_detected' as const,
  VULNERABILITY_REMEDIATION_SCHEDULED: 'vulnerability.remediation_scheduled' as const,
  VULNERABILITY_REMEDIATED: 'vulnerability.remediated' as const,
  // Backup verification
  BACKUP_VERIFICATION_FAILED: 'backup.verification_failed' as const,
  BACKUP_VERIFICATION_PASSED: 'backup.verification_passed' as const,
  BACKUP_RECOVERY_READINESS_LOW: 'backup.recovery_readiness_low' as const,
  // Backup and ticket SLA
  BACKUP_SLA_BREACH: 'backup.sla_breach' as const,
  BACKUP_SLA_RESOLVED: 'backup.sla_resolved' as const,
  TICKET_SLA_BREACHED: 'ticket.sla_breached' as const,
  // Ticket lifecycle (#3828 wave-6-3 task 2) — id-only payloads.
  TICKET_CREATED: 'ticket.created' as const,
  TICKET_COMMENTED: 'ticket.commented' as const,
  TICKET_STATUS_CHANGED: 'ticket.status_changed' as const,
  // Metric-anomaly incidents (#3828 wave-6-4 task 2)
  ANOMALY_INCIDENT_OPENED: 'anomaly.incident_opened' as const,
  // Security
  SECURITY_SCORE_CHANGED: 'security.score_changed' as const,
  CIS_DEVIATION: 'compliance.cis_deviation' as const,
  CIS_SCORE_CHANGED: 'compliance.cis_score_changed' as const,
  CIS_REMEDIATION_APPLIED: 'compliance.cis_remediation_applied' as const,
  S1_THREAT_DETECTED: 's1.threat_detected' as const,
  S1_DEVICE_ISOLATED: 's1.device_isolated' as const,
  S1_THREAT_ACTION_COMPLETED: 's1.threat_action_completed' as const,
  HUNTRESS_INCIDENT_CREATED: 'huntress.incident_created' as const,
  HUNTRESS_INCIDENT_UPDATED: 'huntress.incident_updated' as const,
  HUNTRESS_AGENT_OFFLINE: 'huntress.agent_offline' as const,
  COMPLIANCE_SENSITIVE_DATA_FOUND: 'compliance.sensitive_data_found' as const,
  COMPLIANCE_CREDENTIAL_EXPOSED: 'compliance.credential_exposed' as const,
  COMPLIANCE_SENSITIVE_DATA_REMEDIATED: 'compliance.sensitive_data_remediated' as const,
  COMPLIANCE_BROWSER_POLICY_APPLIED: 'compliance.browser_policy_applied' as const,
  // DNS Security (#829)
  DNS_THREAT_BLOCKED: 'dns.threat.blocked' as const,
  // Remote
  REMOTE_SESSION_STARTED: 'remote.session.started' as const,
  REMOTE_SESSION_ENDED: 'remote.session.ended' as const,
  // User
  USER_LOGIN: 'user.login' as const,
  USER_LOGOUT: 'user.logout' as const,
  USER_MFA_ENABLED: 'user.mfa.enabled' as const,
  USER_RISK_SCORE_HIGH: 'user.risk_score_high' as const,
  USER_RISK_SCORE_SPIKE: 'user.risk_score_spike' as const,
  USER_TRAINING_ASSIGNED: 'user.training_assigned' as const,
  // Device sessions
  SESSION_LOGIN: 'session.login' as const,
  SESSION_LOGOUT: 'session.logout' as const,
  // Compliance
  COMPLIANCE_AUDIT_DEVIATION: 'compliance.audit_deviation' as const,
  COMPLIANCE_AUDIT_REMEDIATED: 'compliance.audit_remediated' as const,
  // Peripheral control
  PERIPHERAL_UNAUTHORIZED_DEVICE: 'peripheral.unauthorized_device' as const,
  PERIPHERAL_BLOCKED: 'peripheral.blocked' as const,
  PERIPHERAL_POLICY_CHANGED: 'peripheral.policy_changed' as const,
  // Service and process monitoring
  MONITORING_CHECK_FAILED: 'monitoring.check_failed' as const,
  MONITORING_CHECK_RECOVERED: 'monitoring.check_recovered' as const,
  // PAM elevation lifecycle
  ELEVATION_REQUESTED: 'elevation.requested' as const,
  ELEVATION_AUTO_APPROVED: 'elevation.auto_approved' as const,
  ELEVATION_APPROVED: 'elevation.approved' as const,
  ELEVATION_DENIED: 'elevation.denied' as const,
  ELEVATION_ACTIVATED: 'elevation.activated' as const,
  ELEVATION_EXPIRED: 'elevation.expired' as const,
  ELEVATION_REVOKED: 'elevation.revoked' as const,
  // AI agents
  AI_AGENT_POLICY_CHANGED: 'ai.agent.policy_changed' as const,
  AI_AGENT_RUN_QUEUED: 'ai.agent.run.queued' as const,
  AI_AGENT_RUN_STARTED: 'ai.agent.run.started' as const,
  AI_AGENT_RUN_AWAITING_APPROVAL: 'ai.agent.run.awaiting_approval' as const,
  AI_AGENT_RUN_COMPLETED: 'ai.agent.run.completed' as const,
  AI_AGENT_RUN_FAILED: 'ai.agent.run.failed' as const,
  AI_AGENT_RUN_SKIPPED: 'ai.agent.run.skipped' as const,
  // #4205
  AI_AGENT_CIRCUIT_OPENED: 'ai.agent.circuit.opened' as const,
  // #4388
  AI_BUDGET_THRESHOLD_CROSSED: 'ai.budget.threshold_crossed' as const,
  // Wave 2 (#3823). Addressed to one user via publishUserEvent — never
  // broadcast, never written to the stream or the global channel.
  NOTIFICATION_CREATED: 'notification.created' as const,
};
