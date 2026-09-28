import { and, asc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  topologyPolicyAlertStateSchema,
  type TopologyAlertStreak,
  type TopologyPolicyDefinition,
  type TopologyScope,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { topologyChangeOutbox, topologyDiagnosticRuns, topologyMonitoringPolicies } from '../../db/schema';
import { openTopologyPolicyAlert, recoverTopologyPolicyAlert, TOPOLOGY_ALERT_NOTIFY_COOLDOWN_MS } from './monitoringAlerts';
import { TOPOLOGY_MONITORING_GAP_EVENT, type TopologyMonitoringGapEvent } from './monitoringEvents';
import { topologyContinuityKey } from './monitoringSlots';

/**
 * Recurring health streaks (M3 Task 8, amendments M3-D8/D11/D15).
 *
 * `advanceTopologyAlertStreak` is the pure, deterministic state machine: it
 * orders by the SERVER slot (`scheduledFor`), never arrival time; an older or
 * equal slot and a stale policy revision are true no-ops; a new continuity
 * (origin/revision) starts a fresh series; only a complete, fresh, scheduled
 * measurement advances a counter; thresholds are the policy's configured
 * values. `applyTopologyPolicyAssessments` feeds it the policy's committed gap
 * events and settled scheduled runs in slot order under the policy row lock
 * and commits streak state, alert transitions and event state together.
 */
export type TopologyMonitoringEvent = {
  kind: 'scheduled_result' | 'scheduled_gap' | 'on_demand_result';
  policyRevision: string;
  contextKey: string;
  family: 'ipv4' | 'ipv6';
  scheduledFor: string;
  occurrenceKey: string;
  continuityKey: string | null;
  coverage: 'complete' | 'partial' | 'none';
  freshness: 'fresh' | 'stale';
  assessment: 'healthy' | 'degraded' | 'failed_check' | 'unknown';
  runId: string | null;
  originDeviceId: string | null;
  originAgentId: string | null;
  reason: string | null;
};
export type TopologyAlertDecision = { streak: TopologyAlertStreak; action: 'open' | 'recover' | 'none' };
export type TopologyAlertThresholds = Pick<TopologyPolicyDefinition, 'failureThreshold' | 'recoveryThreshold' | 'alertsEnabled'>;

export function advanceTopologyAlertStreak(previous: TopologyAlertStreak, event: TopologyMonitoringEvent, thresholds: TopologyAlertThresholds): TopologyAlertDecision {
  if (event.kind === 'on_demand_result') return { streak: previous, action: 'none' };
  if (event.policyRevision !== previous.policyRevision) return { streak: previous, action: 'none' };
  if (previous.lastAppliedScheduledFor !== null && Date.parse(event.scheduledFor) <= Date.parse(previous.lastAppliedScheduledFor)) {
    return { streak: previous, action: 'none' }; // duplicate/older result or gap never resets a newer streak
  }
  const continuityKey = event.continuityKey ?? previous.continuityKey;
  const next: TopologyAlertStreak = {
    ...previous,
    lastAppliedScheduledFor: event.scheduledFor,
    lastAppliedOccurrenceKey: event.occurrenceKey,
    continuityKey,
    ...(event.originDeviceId ? { originDeviceId: event.originDeviceId, originAgentId: event.originAgentId } : {}),
  };
  const base = continuityKey === previous.continuityKey ? next : { ...next, consecutiveFailures: 0, consecutiveSuccesses: 0 };
  const advances = event.kind === 'scheduled_result' && event.coverage === 'complete' && event.freshness === 'fresh'
    && (event.assessment === 'failed_check' || event.assessment === 'healthy');
  if (!advances) return { streak: { ...base, consecutiveFailures: 0, consecutiveSuccesses: 0 }, action: 'none' };
  const consecutiveFailures = event.assessment === 'failed_check' ? base.consecutiveFailures + 1 : 0;
  const consecutiveSuccesses = event.assessment === 'healthy' ? base.consecutiveSuccesses + 1 : 0;
  const action = thresholds.alertsEnabled && consecutiveFailures >= thresholds.failureThreshold && !base.activeAlertId ? 'open'
    : consecutiveSuccesses >= thresholds.recoveryThreshold && base.activeAlertId ? 'recover' : 'none';
  return { streak: { ...base, consecutiveFailures, consecutiveSuccesses }, action };
}

const TERMINAL = ['completed', 'failed', 'cancelled', 'expired'];
type RunRow = typeof topologyDiagnosticRuns.$inferSelect;

/**
 * A settled scheduled run as a streak event. Only a completed run inside its
 * lifetime is a fresh measurement. Continuity is keyed by the run's ACTUAL,
 * immutable origin (PR #7117 C6): an eligible_collector policy may run from a
 * different collector on a later occurrence, and a series must never mix
 * measurements from two origins.
 */
export function runToMonitoringEvent(run: RunRow): TopologyMonitoringEvent {
  const completed = run.state === 'completed';
  const continuityKey = topologyContinuityKey({
    policyId: run.policyId!, policyRevision: run.policyRevision!.toString(), contextKey: run.scheduledContextKey!, family: run.scheduledFamily!,
    originDeviceId: run.originSnapshot.deviceId, originAgentId: run.originSnapshot.agentId,
  });
  return {
    kind: 'scheduled_result',
    policyRevision: run.policyRevision!.toString(),
    contextKey: run.scheduledContextKey!,
    family: run.scheduledFamily!,
    scheduledFor: run.scheduledFor!.toISOString(),
    occurrenceKey: run.occurrenceKey!,
    continuityKey,
    coverage: completed ? run.coverage as TopologyMonitoringEvent['coverage'] : 'none',
    freshness: completed && run.finishedAt !== null && run.finishedAt.getTime() <= run.deadline.getTime() ? 'fresh' : 'stale',
    assessment: completed ? run.assessment as TopologyMonitoringEvent['assessment'] : 'unknown',
    runId: run.id,
    originDeviceId: run.originSnapshot.deviceId,
    originAgentId: run.originSnapshot.agentId,
    reason: completed ? null : run.failureReason ?? run.state,
  };
}

function gapToMonitoringEvent(gap: TopologyMonitoringGapEvent): TopologyMonitoringEvent {
  return {
    kind: 'scheduled_gap', policyRevision: gap.policyRevision, contextKey: gap.contextKey, family: gap.family, scheduledFor: gap.scheduledFor,
    occurrenceKey: gap.occurrenceKey, continuityKey: null, coverage: 'none', freshness: 'stale', assessment: 'unknown',
    runId: null, originDeviceId: null, originAgentId: null, reason: gap.reason,
  };
}

export type AssessmentSummary = { applied: number; opened: number; recovered: number };

/**
 * Apply every committed, ordered event for one policy. Runs in the caller's
 * system-context transaction. Events after the first still-running slot of a
 * pair wait, so a late earlier result is never turned into an ignored "old" one.
 */
export async function applyTopologyPolicyAssessments(scope: TopologyScope, policyId: string, now = new Date()): Promise<AssessmentSummary> {
  const summary: AssessmentSummary = { applied: 0, opened: 0, recovered: 0 };
  const [policy] = await db.select().from(topologyMonitoringPolicies)
    .where(and(eq(topologyMonitoringPolicies.id, policyId), eq(topologyMonitoringPolicies.orgId, scope.orgId), eq(topologyMonitoringPolicies.siteId, scope.siteId)))
    .for('update');
  if (!policy) return summary;
  const parsed = topologyPolicyAlertStateSchema.safeParse(policy.alertState);
  if (!parsed.success) return summary;
  const definition = policy.definition as TopologyPolicyDefinition;
  const revision = policy.revision.toString();
  const entries = new Map(parsed.data.entries.map((entry) => [`${entry.contextKey}\u0000${entry.family}`, entry]));

  const gapRows = await db.select().from(topologyChangeOutbox)
    .where(and(eq(topologyChangeOutbox.orgId, scope.orgId), eq(topologyChangeOutbox.siteId, scope.siteId), eq(topologyChangeOutbox.eventKind, TOPOLOGY_MONITORING_GAP_EVENT),
      eq(topologyChangeOutbox.aggregateId, policyId), sql`${topologyChangeOutbox.payload}->>'state' = 'pending'`))
    .orderBy(asc(topologyChangeOutbox.createdAt)).limit(256);
  // Per-pair cursor (PR #7117 C1): only runs of an armed pair AFTER its last
  // applied slot. Without it the oldest 512 runs of the revision — all already
  // applied — were reloaded forever once history passed 512 and new
  // occurrences were never assessed. Every loaded settled run before the
  // barrier advances its pair's cursor, so each pass makes progress.
  const pairCursors = [...entries.values()].map((entry) => and(
    eq(topologyDiagnosticRuns.scheduledContextKey, entry.contextKey),
    eq(topologyDiagnosticRuns.scheduledFamily, entry.family),
    entry.lastAppliedScheduledFor === null ? undefined : gt(topologyDiagnosticRuns.scheduledFor, new Date(entry.lastAppliedScheduledFor)),
  ));
  const runs = pairCursors.length === 0 ? [] : await db.select().from(topologyDiagnosticRuns)
    .where(and(eq(topologyDiagnosticRuns.orgId, scope.orgId), eq(topologyDiagnosticRuns.siteId, scope.siteId), eq(topologyDiagnosticRuns.policyId, policyId),
      eq(topologyDiagnosticRuns.policyRevision, policy.revision), isNotNull(topologyDiagnosticRuns.scheduledFor), or(...pairCursors)))
    .orderBy(asc(topologyDiagnosticRuns.scheduledFor)).limit(512);

  // Per pair, nothing at or after the first unsettled slot is applied yet.
  const barrier = new Map<string, number>();
  for (const run of runs) {
    if (TERMINAL.includes(run.state)) continue;
    const key = `${run.scheduledContextKey}\u0000${run.scheduledFamily}`;
    barrier.set(key, Math.min(barrier.get(key) ?? Infinity, run.scheduledFor!.getTime()));
  }
  const events: Array<{ event: TopologyMonitoringEvent; gapRowId?: string }> = [
    ...runs.filter((run) => TERMINAL.includes(run.state)).map((run) => ({ event: runToMonitoringEvent(run) })),
    ...gapRows.map((row) => ({ event: gapToMonitoringEvent(row.payload as unknown as TopologyMonitoringGapEvent), gapRowId: row.id })),
  ].filter(({ event }) => Date.parse(event.scheduledFor) < (barrier.get(`${event.contextKey}\u0000${event.family}`) ?? Infinity))
    .sort((a, b) => Date.parse(a.event.scheduledFor) - Date.parse(b.event.scheduledFor) || a.event.occurrenceKey.localeCompare(b.event.occurrenceKey));

  let changed = false;
  const settledGaps: string[] = [];
  for (const { event, gapRowId } of events) {
    if (gapRowId) settledGaps.push(gapRowId);
    const key = `${event.contextKey}\u0000${event.family}`;
    const previous = entries.get(key);
    if (!previous || event.policyRevision !== revision) continue;
    const decision = advanceTopologyAlertStreak(previous, event, definition);
    if (decision.streak === previous) continue;
    let streak = decision.streak;
    if (decision.action === 'open' && event.originDeviceId) {
      const notify = !previous.lastNotifiedAt || now.getTime() - Date.parse(previous.lastNotifiedAt) >= TOPOLOGY_ALERT_NOTIFY_COOLDOWN_MS;
      const opened = await openTopologyPolicyAlert({
        scope, policy: { id: policy.id, key: policy.key, definition }, contextKey: event.contextKey, family: event.family,
        occurrenceKey: event.occurrenceKey, originDeviceId: event.originDeviceId, runId: event.runId,
        consecutiveFailures: streak.consecutiveFailures, notify, now,
      });
      streak = { ...streak, activeAlertId: opened.alertId, lastNotifiedAt: notify ? now.toISOString() : previous.lastNotifiedAt };
      if (opened.created) summary.opened++;
    } else if (decision.action === 'recover' && previous.activeAlertId) {
      if (await recoverTopologyPolicyAlert({ scope, alertId: previous.activeAlertId, policyId: policy.id, contextKey: event.contextKey, family: event.family,
        occurrenceKey: event.occurrenceKey, consecutiveSuccesses: streak.consecutiveSuccesses, now })) summary.recovered++;
      streak = { ...streak, activeAlertId: null };
    }
    entries.set(key, streak);
    changed = true;
    summary.applied++;
  }
  if (settledGaps.length) {
    await db.update(topologyChangeOutbox)
      .set({ payload: sql`jsonb_set(${topologyChangeOutbox.payload}, '{state}', '"applied"')`, updatedAt: now })
      .where(inArray(topologyChangeOutbox.id, settledGaps));
  }
  if (changed) {
    const alertState = topologyPolicyAlertStateSchema.parse({ schemaVersion: 1, entries: parsed.data.entries.map((entry) => entries.get(`${entry.contextKey}\u0000${entry.family}`) ?? entry) });
    await db.update(topologyMonitoringPolicies)
      .set({ alertState, alertStateRevision: sql`${topologyMonitoringPolicies.alertStateRevision}+1`, updatedAt: now })
      .where(eq(topologyMonitoringPolicies.id, policy.id));
  }
  return summary;
}

/**
 * Typed consumer (M3-D15): every policy with a pending gap event or a settled
 * scheduled run newer than its applied slot, each in its own short
 * system-context transaction.
 */
export async function drainTopologyMonitoringAssessments(options: { limit?: number; now?: Date } = {}): Promise<AssessmentSummary> {
  const limit = options.limit ?? 50;
  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ policy_id: string; org_id: string; site_id: string }>(sql`
    SELECT DISTINCT policy_id, org_id, site_id FROM (
      SELECT o.aggregate_id AS policy_id, o.org_id, o.site_id FROM topology_change_outbox o
       WHERE o.event_kind = ${TOPOLOGY_MONITORING_GAP_EVENT} AND o.payload->>'state' = 'pending'
      UNION
      SELECT r.policy_id, r.org_id, r.site_id FROM topology_diagnostic_runs r
        JOIN topology_monitoring_policies p ON p.id = r.policy_id AND p.org_id = r.org_id AND p.site_id = r.site_id
       WHERE r.policy_id IS NOT NULL AND r.state IN ('completed','failed','cancelled','expired') AND r.policy_revision = p.revision
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.alert_state->'entries') e
                      WHERE e->>'contextKey' = r.scheduled_context_key AND e->>'family' = r.scheduled_family
                        AND (e->>'lastAppliedScheduledFor' IS NULL OR (e->>'lastAppliedScheduledFor')::timestamptz < r.scheduled_for))
    ) pending LIMIT ${limit}`), 'topology monitoring assessment discovery'));
  const total: AssessmentSummary = { applied: 0, opened: 0, recovered: 0 };
  for (const row of due) {
    const summary = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(() =>
      applyTopologyPolicyAssessments({ orgId: row.org_id, siteId: row.site_id }, row.policy_id, options.now)), 'topology monitoring assessment'));
    total.applied += summary.applied; total.opened += summary.opened; total.recovered += summary.recovered;
  }
  return total;
}
