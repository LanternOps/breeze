import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import type { TopologyPolicyDefinition, TopologyScope } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { alerts, topologyChangeOutbox } from '../../db/schema';
import { publishEvent } from '../eventBus';
import { TOPOLOGY_MONITORING_ALERT_EVENT, type TopologyMonitoringAlertEvent } from './monitoringEvents';

/**
 * Site-owned topology policy alerts (M3 Task 8, amendment M3-D6).
 *
 * The alert row is committed in the same transaction as the streak state
 * that decided it, keyed by an ORIGIN-INDEPENDENT source key
 * (site/policy/context/family) with a partial unique index on open alerts, so
 * a replay, a second replica or an origin switch re-uses the one open alert.
 * The origin device is stored as provenance (`device_id`), never as owner.
 * Notification fan-out happens after commit from the typed
 * `monitoring.alert_transition` outbox event (M3-D15), idempotent per
 * occurrence, with the 5-minute re-notify cooldown decided at commit time.
 */
export const TOPOLOGY_ALERT_NOTIFY_COOLDOWN_MS = 5 * 60_000;
const OPEN_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

export function topologyPolicyAlertSourceKey(input: { scope: TopologyScope; policyId: string; contextKey: string; family: 'ipv4' | 'ipv6' }): string {
  return `topology:${createHash('sha256').update(canonicalizeArguments({ kind: 'topology-policy-alert-v1', ...input.scope, policyId: input.policyId, contextKey: input.contextKey, family: input.family })).digest('hex')}`;
}

async function recordTransition(scope: TopologyScope, event: Omit<TopologyMonitoringAlertEvent, 'version' | 'kind' | 'state'>): Promise<void> {
  const payload: TopologyMonitoringAlertEvent = { version: 1, kind: TOPOLOGY_MONITORING_ALERT_EVENT, state: 'pending', ...event };
  await db.insert(topologyChangeOutbox).values({
    ...scope,
    eventKind: TOPOLOGY_MONITORING_ALERT_EVENT,
    aggregateId: event.alertId,
    sourceRevision: 0n,
    idempotencyKey: `monitoring-alert:${event.occurrenceKey}:${event.action}`,
    payload: payload as unknown as Record<string, unknown>,
    deliveredAt: new Date(),
  }).onConflictDoNothing();
}

/** Open (or re-use) the one site-owned alert for a policy context/family. Caller owns the transaction. */
export async function openTopologyPolicyAlert(input: {
  scope: TopologyScope;
  policy: { id: string; key: string; definition: TopologyPolicyDefinition };
  contextKey: string;
  family: 'ipv4' | 'ipv6';
  occurrenceKey: string;
  originDeviceId: string;
  runId: string | null;
  consecutiveFailures: number;
  notify: boolean;
  now: Date;
}): Promise<{ alertId: string; created: boolean }> {
  const sourceKey = topologyPolicyAlertSourceKey({ scope: input.scope, policyId: input.policy.id, contextKey: input.contextKey, family: input.family });
  const recipe = input.policy.definition.recipeId.replace(/_/g, ' ');
  const [created] = await db.insert(alerts).values({
    ruleId: null,
    deviceId: input.originDeviceId,
    orgId: input.scope.orgId,
    topologySiteId: input.scope.siteId,
    topologySourceKey: sourceKey,
    severity: 'high',
    title: `Recurring ${recipe} check failing: ${input.policy.key}`.slice(0, 500),
    message: `${input.consecutiveFailures} consecutive scheduled ${recipe} checks failed on ${input.contextKey}/${input.family}.`,
    context: {
      source: 'topology_monitoring',
      policyId: input.policy.id,
      policyKey: input.policy.key,
      contextKey: input.contextKey,
      family: input.family,
      runId: input.runId,
      occurrenceKey: input.occurrenceKey,
      consecutiveFailures: input.consecutiveFailures,
    },
    status: 'active',
    triggeredAt: input.now,
  }).onConflictDoNothing().returning({ id: alerts.id });
  if (created) {
    await recordTransition(input.scope, { action: 'open', alertId: created.id, policyId: input.policy.id, contextKey: input.contextKey, family: input.family, occurrenceKey: input.occurrenceKey, notify: input.notify });
    return { alertId: created.id, created: true };
  }
  const [existing] = await db.select({ id: alerts.id }).from(alerts)
    .where(and(eq(alerts.orgId, input.scope.orgId), eq(alerts.topologySiteId, input.scope.siteId), eq(alerts.topologySourceKey, sourceKey), inArray(alerts.status, [...OPEN_STATUSES])))
    .limit(1);
  if (!existing) throw new Error('topology policy alert conflict without an open alert');
  return { alertId: existing.id, created: false };
}

/** Resolve the policy's open alert after the configured healthy streak. Caller owns the transaction. */
export async function recoverTopologyPolicyAlert(input: {
  scope: TopologyScope; alertId: string; policyId: string; contextKey: string; family: 'ipv4' | 'ipv6';
  occurrenceKey: string; consecutiveSuccesses: number; now: Date;
}): Promise<boolean> {
  const [resolved] = await db.update(alerts)
    .set({ status: 'resolved', resolvedAt: input.now, resolutionNote: `Recovered after ${input.consecutiveSuccesses} consecutive healthy scheduled checks` })
    .where(and(eq(alerts.id, input.alertId), eq(alerts.orgId, input.scope.orgId), eq(alerts.topologySiteId, input.scope.siteId), inArray(alerts.status, ['active', 'acknowledged'])))
    .returning({ id: alerts.id });
  if (!resolved) return false;
  await recordTransition(input.scope, { action: 'recover', alertId: input.alertId, policyId: input.policyId, contextKey: input.contextKey, family: input.family, occurrenceKey: input.occurrenceKey, notify: true });
  return true;
}

export type TopologyAlertPublisher = typeof publishEvent;

/**
 * Typed consumer for committed alert transitions: publishes `alert.triggered`
 * / `alert.resolved` scoped to the TOPOLOGY site, then marks the event
 * applied. A failed publish stays pending and is retried; a suppressed
 * (cooldown) open is applied without publishing.
 */
export async function drainTopologyAlertTransitions(options: { limit?: number; publish?: TopologyAlertPublisher } = {}): Promise<number> {
  const publish = options.publish ?? publishEvent;
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select().from(topologyChangeOutbox)
    .where(and(eq(topologyChangeOutbox.eventKind, TOPOLOGY_MONITORING_ALERT_EVENT), sql`${topologyChangeOutbox.payload}->>'state' = 'pending'`,
      sql`(${topologyChangeOutbox.nextAttemptAt} IS NULL OR ${topologyChangeOutbox.nextAttemptAt} <= now())`))
    .orderBy(asc(topologyChangeOutbox.createdAt), asc(topologyChangeOutbox.id))
    .limit(options.limit ?? 50), 'topology alert transitions'));
  let applied = 0;
  for (const row of rows) {
    const event = row.payload as unknown as TopologyMonitoringAlertEvent;
    try {
      if (event.notify) {
        const [alert] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.id, event.alertId)).limit(1), 'topology alert transition read'));
        if (alert && alert.orgId === row.orgId) {
          const common = { alertId: alert.id, ruleId: null, deviceId: alert.deviceId, source: 'topology_monitoring', topologySiteId: alert.topologySiteId };
          if (event.action === 'open') {
            await publish('alert.triggered', alert.orgId, { ...common, severity: alert.severity, title: alert.title, message: alert.message, monitorId: null, kind: null }, 'topology-monitoring', { siteId: row.siteId });
          } else {
            await publish('alert.resolved', alert.orgId, { ...common, resolutionNote: alert.resolutionNote, resolvedAt: alert.resolvedAt?.toISOString() ?? null, resolvedBy: null,
              triggeredAt: alert.triggeredAt.toISOString() }, 'topology-monitoring', { siteId: row.siteId });
          }
        }
      }
      await runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(topologyChangeOutbox)
        .set({ payload: sql`jsonb_set(${topologyChangeOutbox.payload}, '{state}', '"applied"')`, updatedAt: new Date(), lastError: null })
        .where(eq(topologyChangeOutbox.id, row.id)), 'topology alert transition applied'));
      applied++;
    } catch {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(topologyChangeOutbox)
        .set({ attemptCount: sql`${topologyChangeOutbox.attemptCount}+1`, lastAttemptAt: new Date(), nextAttemptAt: new Date(Date.now() + 30_000), lastError: 'alert_publish_retry_pending' })
        .where(eq(topologyChangeOutbox.id, row.id)), 'topology alert transition retry'));
    }
  }
  return applied;
}
