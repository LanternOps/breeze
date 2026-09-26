import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import {
  topologyPolicyAlertStateSchema,
  topologyPolicyRoutingContextsSchema,
  type TopologyAlertStreak,
  type TopologyPolicyDefinition,
  type TopologyPolicyRoutingContext,
  type TopologyScope,
} from '@breeze/shared';
import { db, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { devices, topologyChangeOutbox, topologyMonitoringPolicies } from '../../db/schema';
import type { TopologyRequestContext } from './access';
import { createTopologyDiagnosticRun } from './diagnosticRuns';
import type { DiagnosticPlanningRepository } from './diagnosticTypes';
import { loadPolicyTargetPins, rearmAlertState, type PolicyTargetPin } from './monitoringArming';
import { withTopologyArmAuthority, type TopologyArmAuthorityDeps } from './monitoringAuthority';
import { TOPOLOGY_MONITORING_GAP_EVENT, type TopologyMonitoringGapEvent } from './monitoringEvents';
import { disarmPolicyRow } from './monitoringPolicyState';
import { reusableTopologyMonitor } from './monitorBindings';
import { nextTopologyPolicyDueAt, topologyContinuityKey, topologyOccurrenceKey, topologyOccurrenceSlot } from './monitoringSlots';
import { TopologyOperationError } from './operationErrors';
import { topologyDiagnosticRepository } from './originEligibility';

/**
 * Recurring policy scheduler (M3 Task 7; amendments M3-D11/D13/D14).
 *
 * For each due, armed policy: re-derive the arming actor's LIVE authority and
 * run as that actor; then, in ONE transaction holding the policy row, claim
 * the current slot for every armed context/family and commit either its run
 * (+ dispatch intent, via createTopologyDiagnosticRun) or a bounded
 * `monitoring.gap` event, together with the streak-state CAS. Missed slots
 * during downtime collapse into one gap; nothing is ever replayed. Planning is
 * restricted to the policy's pinned targets and bound routing context.
 */
type PolicyRow = typeof topologyMonitoringPolicies.$inferSelect;

export type TopologySchedulerDeps = {
  now?: Date;
  limit?: number;
  /** Fairness: at most this many policies per site per tick. */
  perSite?: number;
  repository?: DiagnosticPlanningRepository;
  authority?: TopologyArmAuthorityDeps;
};

export type TopologySchedulerResult = { scheduled: number; gaps: number; skipped: number; disarmed: number };

const system = <T>(fn: () => Promise<T>, label: string) => runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/** Planning restricted to the policy's pinned target set and (for an original reporter) its bound source generation. */
export function restrictedPlanningRepository(
  base: DiagnosticPlanningRepository,
  pins: ReadonlyArray<PolicyTargetPin>,
  binding: TopologyPolicyRoutingContext | null,
): DiagnosticPlanningRepository & { generationDrift: () => boolean } {
  let drift = false;
  return {
    generationDrift: () => drift,
    load: async (ctx, request) => {
      const snapshot = await base.load(ctx, request);
      const targets = snapshot.targets.filter((target) => pins.some((pin) => pin.id === target.id && pin.revision === target.revision));
      const candidates = binding
        ? snapshot.candidates.filter((candidate) => {
          const origin = candidate.eligibility.origin;
          if (origin.deviceId !== binding.originDeviceId) return true;
          const same = origin.sourceId === binding.sourceId && origin.interfaceEpoch === binding.interfaceEpoch;
          if (!same) drift = true;
          return same;
        })
        : snapshot.candidates;
      return { ...snapshot, targets, candidates };
    },
  };
}

/** The policy's due candidates, round-robin across sites so one busy site cannot starve the rest. */
async function duePolicies(now: Date, limit: number, perSite: number): Promise<PolicyRow[]> {
  const rows = await system(() => db.select().from(topologyMonitoringPolicies)
    .where(and(eq(topologyMonitoringPolicies.enabled, true), isNull(topologyMonitoringPolicies.deletedAt), lte(topologyMonitoringPolicies.nextScheduledAt, now)))
    .orderBy(asc(topologyMonitoringPolicies.nextScheduledAt), asc(topologyMonitoringPolicies.id))
    .limit(limit * 4), 'topology monitoring due policies');
  const bySite = new Map<string, PolicyRow[]>();
  for (const row of rows) bySite.set(row.siteId, [...(bySite.get(row.siteId) ?? []), row]);
  const picked: PolicyRow[] = [];
  for (let round = 0; round < perSite && picked.length < limit; round++) {
    for (const queue of bySite.values()) {
      const next = queue[round];
      if (next && picked.length < limit) picked.push(next);
    }
  }
  return picked;
}

function freshEntry(context: TopologyPolicyRoutingContext, policyRevision: string): TopologyAlertStreak {
  return rearmAlertState({ schemaVersion: 1, entries: [] }, [context], policyRevision).entries[0]!;
}

async function insertGap(scope: TopologyScope, gap: TopologyMonitoringGapEvent): Promise<boolean> {
  const inserted = await db.insert(topologyChangeOutbox).values({
    ...scope,
    eventKind: TOPOLOGY_MONITORING_GAP_EVENT,
    aggregateId: gap.policyId,
    sourceRevision: 0n,
    idempotencyKey: `monitoring-gap:${gap.occurrenceKey}`,
    payload: gap as unknown as Record<string, unknown>,
    // Pre-stamped like every feature journal so the legacy graph replay never
    // sees it; its own typed consumer selects on event_kind + payload state.
    deliveredAt: new Date(),
  }).onConflictDoNothing().returning({ id: topologyChangeOutbox.id });
  return inserted.length > 0;
}

/** Gap reasons are bounded, stable codes (never an exception message). */
function gapReason(error: TopologyOperationError): string {
  if (error.code === 'diagnostic_quota_exceeded') return 'budget_exhausted';
  return /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'occurrence_refused';
}

type ClaimOutcome =
  | { kind: 'claimed'; scheduled: number; gaps: number }
  | { kind: 'stale' }
  | { kind: 'disarm'; reason: string };

async function claimPolicySlot(ctx: TopologyRequestContext, snapshot: PolicyRow, now: Date, deps: TopologySchedulerDeps): Promise<ClaimOutcome> {
  const [row] = await db.select().from(topologyMonitoringPolicies)
    .where(and(eq(topologyMonitoringPolicies.id, snapshot.id), eq(topologyMonitoringPolicies.orgId, ctx.scope.orgId), eq(topologyMonitoringPolicies.siteId, ctx.scope.siteId)))
    .for('update');
  if (!row || !row.enabled || row.deletedAt !== null || row.authorityDigest !== snapshot.authorityDigest || row.revision !== snapshot.revision
    || row.alertStateRevision !== snapshot.alertStateRevision) return { kind: 'stale' };
  const definition = row.definition as TopologyPolicyDefinition;
  const { pins, drift } = await loadPolicyTargetPins(ctx.scope, row.id);
  if (drift) return { kind: 'disarm', reason: drift };
  const contexts = topologyPolicyRoutingContextsSchema.safeParse(row.routingContexts);
  const state = topologyPolicyAlertStateSchema.safeParse(row.alertState);
  if (!contexts.success || !contexts.data.length || !state.success) return { kind: 'disarm', reason: 'runtime_state_invalid' };

  const policyRevision = row.revision.toString();
  const intervalMs = definition.intervalSeconds * 1000;
  const slot = topologyOccurrenceSlot(definition.intervalSeconds, now);
  const entries = new Map(state.data.entries.map((entry) => [`${entry.contextKey}\u0000${entry.family}`, entry]));
  let scheduled = 0, gaps = 0, generationDrift = false;

  for (const context of contexts.data) {
    const pairKey = `${context.contextKey}\u0000${context.family}`;
    const entry = entries.get(pairKey) ?? freshEntry(context, policyRevision);
    const lastClaimed = entry.lastClaimedScheduledFor ? Date.parse(entry.lastClaimedScheduledFor) : null;
    if (lastClaimed !== null && lastClaimed >= slot.getTime()) { entries.set(pairKey, entry); continue; }
    const occurrenceKey = topologyOccurrenceKey({ scope: ctx.scope, policyId: row.id, contextKey: context.contextKey, family: context.family, scheduledFor: slot });
    const base = { version: 1 as const, kind: TOPOLOGY_MONITORING_GAP_EVENT, state: 'pending' as const, policyId: row.id, policyRevision, contextKey: context.contextKey, family: context.family };

    // Downtime collapses into ONE bounded gap for the missed range; no probe per missed interval.
    const missedCount = lastClaimed === null ? 0 : Math.floor((slot.getTime() - lastClaimed) / intervalMs) - 1;
    if (missedCount > 0) {
      const lastMissed = new Date(slot.getTime() - intervalMs);
      if (await insertGap(ctx.scope, {
        ...base, reason: 'missed_while_unavailable', scheduledFor: lastMissed.toISOString(),
        occurrenceKey: topologyOccurrenceKey({ scope: ctx.scope, policyId: row.id, contextKey: context.contextKey, family: context.family, scheduledFor: lastMissed }),
        missedCount, missedFrom: new Date(lastClaimed! + intervalMs).toISOString(), missedTo: lastMissed.toISOString(),
      })) gaps++;
    }

    // M3-D5: a still-equivalent bound monitor supplies this context's health;
    // the slot is claimed without a probe run (a drifted binding is dropped).
    if (await reusableTopologyMonitor(ctx.scope, { id: row.id, revision: row.revision, definition }, context)) {
      entries.set(pairKey, { ...entry, lastClaimedScheduledFor: slot.toISOString(), lastClaimedOccurrenceKey: occurrenceKey });
      continue;
    }
    const [origin] = await db.select({ agentId: devices.agentId }).from(devices).where(eq(devices.id, context.originDeviceId)).limit(1);
    const continuityKey = topologyContinuityKey({ policyId: row.id, policyRevision, contextKey: context.contextKey, family: context.family,
      originDeviceId: context.originDeviceId, originAgentId: origin?.agentId ?? 'unknown' });
    const repository = restrictedPlanningRepository(deps.repository ?? topologyDiagnosticRepository, pins,
      definition.origin === 'original_reporter' ? context : null);
    let refused: string | null = null;
    try {
      if (!origin) throw new TopologyOperationError('origin_unavailable', 409);
      await createTopologyDiagnosticRun(ctx, {
        recipeId: definition.recipeId,
        recipeVersion: 1,
        subject: { kind: 'node', id: context.originNodeId },
        graphRevision: '0',
        ...(definition.origin === 'original_reporter' ? { originDeviceId: context.originDeviceId } : {}),
        contextKey: context.contextKey,
        family: context.family,
      }, occurrenceKey, {
        repository,
        scheduledOccurrence: { policyId: row.id, policyRevision, contextKey: context.contextKey, family: context.family, scheduledFor: slot, occurrenceKey, continuityKey },
      });
      scheduled++;
    } catch (error) {
      if (pgErrorCode(error) === '23505') { entries.set(pairKey, entry); continue; }
      if (!(error instanceof TopologyOperationError)) throw error;
      if (error.status === 403) return { kind: 'disarm', reason: `authority_${error.code}`.slice(0, 64) };
      if (error.status === 503) throw error;
      refused = repository.generationDrift() ? 'context_generation_changed' : gapReason(error);
      generationDrift ||= refused === 'context_generation_changed';
    }
    if (refused && await insertGap(ctx.scope, { ...base, reason: refused, scheduledFor: slot.toISOString(), occurrenceKey, missedCount: 0, missedFrom: null, missedTo: null })) gaps++;
    entries.set(pairKey, { ...entry, lastClaimedScheduledFor: slot.toISOString(), lastClaimedOccurrenceKey: occurrenceKey });
  }

  const alertState = topologyPolicyAlertStateSchema.parse({
    schemaVersion: 1,
    entries: contexts.data.map((context) => entries.get(`${context.contextKey}\u0000${context.family}`) ?? freshEntry(context, policyRevision)),
  });
  const [updated] = await db.update(topologyMonitoringPolicies)
    .set({
      alertState,
      alertStateRevision: sql`${topologyMonitoringPolicies.alertStateRevision}+1`,
      lastScheduledAt: slot,
      nextScheduledAt: nextTopologyPolicyDueAt(row.id, definition.intervalSeconds, now),
      updatedAt: now,
    })
    .where(and(eq(topologyMonitoringPolicies.id, row.id), eq(topologyMonitoringPolicies.alertStateRevision, row.alertStateRevision)))
    .returning({ id: topologyMonitoringPolicies.id });
  if (!updated) return { kind: 'stale' };
  // A bound original-reporter context whose source/interface generation moved
  // needs a fresh human arm; the gap for this slot is already recorded.
  if (generationDrift) return { kind: 'disarm', reason: 'context_generation_changed' };
  return { kind: 'claimed', scheduled, gaps };
}

/** Persistent denials disarm; a transient one (Redis/permission store down) leaves the policy due. */
const TRANSIENT_DENIALS = new Set(['authority_unavailable']);

export async function dispatchDueTopologyPolicies(deps: TopologySchedulerDeps = {}): Promise<TopologySchedulerResult> {
  const now = deps.now ?? new Date();
  const result: TopologySchedulerResult = { scheduled: 0, gaps: 0, skipped: 0, disarmed: 0 };
  for (const policy of await duePolicies(now, deps.limit ?? 50, deps.perSite ?? 2)) {
    const scope = { orgId: policy.orgId, siteId: policy.siteId };
    const outcome = await withTopologyArmAuthority(policy.authorityActor, scope, ['diagnostics'],
      (ctx) => withDbTransaction(() => claimPolicySlot(ctx, policy, now, deps)), deps.authority);
    const disarmReason = !outcome.ok
      ? (TRANSIENT_DENIALS.has(outcome.reason) ? null : `authority_${outcome.reason}`)
      : outcome.value.kind === 'disarm' ? outcome.value.reason : null;
    if (disarmReason) {
      await system(() => db.transaction(async () => {
        const [current] = await db.select({ id: topologyMonitoringPolicies.id, enabled: topologyMonitoringPolicies.enabled, revision: topologyMonitoringPolicies.revision })
          .from(topologyMonitoringPolicies).where(eq(topologyMonitoringPolicies.id, policy.id)).for('update');
        if (current?.enabled && current.revision === policy.revision) await disarmPolicyRow(scope, current, disarmReason.slice(0, 64));
      }), 'topology monitoring disarm');
      result.disarmed++;
      continue;
    }
    if (!outcome.ok || outcome.value.kind === 'stale') { result.skipped++; continue; }
    if (outcome.value.kind === 'claimed') { result.scheduled += outcome.value.scheduled; result.gaps += outcome.value.gaps; }
  }
  return result;
}
