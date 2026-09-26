import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  topologyPolicyAlertStateSchema,
  topologyPolicyArmStateSchema,
  topologyPolicyRoutingContextsSchema,
  type TopologyPolicyAlertState,
  type TopologyPolicyArmRequest,
  type TopologyPolicyArmState,
  type TopologyPolicyDefinition,
  type TopologyPolicyRoutingContext,
  TOPOLOGY_POLICY_DEFAULT_CONTEXTS,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import {
  auditLogs,
  topologyCollectionSources,
  topologyDiagnosticRuns,
  topologyMonitoringPolicies,
  topologyNodeBindings,
  topologyPolicyTargets,
  topologyProbeTargets,
  topologySiteState,
} from '../../db/schema';
import { requireTopologySiteAccess, type TopologyRequestContext } from './access';
import { loadTopologyFlags } from './flags';
import {
  freezeTopologyArmAuthority,
  requireHumanArmingSession,
  topologyPolicyEffectDigest,
  type TopologyArmAuthorityRecord,
} from './monitoringAuthority';
import { nextTopologyPolicyDueAt } from './monitoringSlots';
import { TopologyOperationError } from './operationErrors';
import { topologyDiagnosticRepository } from './originEligibility';
import type { DiagnosticPlanningRepository } from './diagnosticTypes';
import { expectedRevisionSchema, scopedWrite } from './writes';
import { disarmPolicyRow } from './monitoringPolicyState';
export { disarmPolicyRow } from './monitoringPolicyState';

type PolicyRow = typeof topologyMonitoringPolicies.$inferSelect;
export type PolicyTargetPin = { id: string; revision: string; purpose: string; position: number };

const notFound = () => new TopologyOperationError('policy_not_found', 404, 'Monitoring policy not found');

export function topologyPolicyArmView(row: PolicyRow): TopologyPolicyArmState {
  return topologyPolicyArmStateSchema.parse({
    policyId: row.id,
    revision: row.revision.toString(),
    enabled: row.enabled,
    activationIntent: row.activationIntent,
    blockedReason: row.blockedReason,
    armedAt: row.armedAt?.toISOString() ?? null,
    armedBy: row.enabled ? row.requesterId : null,
    authorityDigest: row.authorityDigest,
    contexts: (row.routingContexts ?? []).map((c) => ({ contextKey: c.contextKey, family: c.family })),
    nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null,
  });
}

/** The policy's pinned targets, checked against the live compiled target rows. */
export async function loadPolicyTargetPins(scope: TopologyRequestContext['scope'], policyId: string): Promise<{ pins: PolicyTargetPin[]; drift: string | null }> {
  const rows = await db
    .select({
      id: topologyPolicyTargets.targetId,
      pinnedRevision: topologyPolicyTargets.targetRevision,
      purpose: topologyPolicyTargets.purpose,
      position: topologyPolicyTargets.position,
      liveRevision: topologyProbeTargets.revision,
      enabled: topologyProbeTargets.enabled,
      deletedAt: topologyProbeTargets.deletedAt,
    })
    .from(topologyPolicyTargets)
    .innerJoin(topologyProbeTargets, and(
      eq(topologyProbeTargets.id, topologyPolicyTargets.targetId),
      eq(topologyProbeTargets.orgId, topologyPolicyTargets.orgId),
      eq(topologyProbeTargets.siteId, topologyPolicyTargets.siteId),
    ))
    .where(and(scopedWrite(scope, topologyPolicyTargets), eq(topologyPolicyTargets.policyId, policyId)))
    .orderBy(asc(topologyPolicyTargets.position));
  const drift = rows.some((r) => r.deletedAt !== null || !r.enabled) ? 'target_disabled'
    : rows.some((r) => r.liveRevision !== r.pinnedRevision) ? 'target_changed' : null;
  return {
    pins: rows.map((r) => ({ id: r.id, revision: r.pinnedRevision.toString(), purpose: r.purpose, position: r.position })),
    drift,
  };
}

/**
 * Candidate routing contexts: every fresh agent `routes` source in the site
 * whose device is bound to a topology node, ordered deterministically.
 */
async function routingContextCandidates(ctx: TopologyRequestContext, families: ReadonlyArray<'ipv4' | 'ipv6'>) {
  const sources = await db
    .select({
      producerId: topologyCollectionSources.producerId,
      contextKey: topologyCollectionSources.contextKey,
      addressFamily: topologyCollectionSources.addressFamily,
      freshUntil: topologyCollectionSources.freshUntil,
    })
    .from(topologyCollectionSources)
    .where(and(
      scopedWrite(ctx.scope, topologyCollectionSources),
      eq(topologyCollectionSources.producerKind, 'agent'),
      eq(topologyCollectionSources.protocol, 'routes'),
      isNull(topologyCollectionSources.revokedAt),
    ))
    .orderBy(asc(topologyCollectionSources.producerId), asc(topologyCollectionSources.contextKey), asc(topologyCollectionSources.addressFamily))
    .limit(1000);
  const deviceIds = [...new Set(sources.map((s) => s.producerId))];
  const bindings = deviceIds.length
    ? await db
      .select({ deviceId: topologyNodeBindings.deviceId, nodeId: topologyNodeBindings.nodeId })
      .from(topologyNodeBindings)
      .where(and(scopedWrite(ctx.scope, topologyNodeBindings), inArray(topologyNodeBindings.deviceId, deviceIds)))
    : [];
  const nodeByDevice = new Map(bindings.map((b) => [b.deviceId!, b.nodeId]));
  const now = Date.now();
  return sources
    .filter((s) => (s.addressFamily === 'ipv4' || s.addressFamily === 'ipv6') && families.includes(s.addressFamily)
      && s.freshUntil !== null && s.freshUntil.getTime() > now && nodeByDevice.has(s.producerId))
    .map((s) => ({ deviceId: s.producerId, nodeId: nodeByDevice.get(s.producerId)!, contextKey: s.contextKey, family: s.addressFamily as 'ipv4' | 'ipv6' }));
}

/** Validate one context through the SAME eligibility the planner uses and bind it to the observed generation. */
export async function bindRoutingContext(
  ctx: TopologyRequestContext,
  definition: TopologyPolicyDefinition,
  candidate: { deviceId: string; nodeId: string; contextKey: string; family: 'ipv4' | 'ipv6' },
  repository: DiagnosticPlanningRepository,
): Promise<{ context: TopologyPolicyRoutingContext } | { reason: string }> {
  const snapshot = await repository.load(ctx, {
    recipeId: definition.recipeId,
    recipeVersion: 1,
    subject: { kind: 'node', id: candidate.nodeId },
    graphRevision: '0',
    originDeviceId: candidate.deviceId,
    contextKey: candidate.contextKey,
    family: candidate.family,
  });
  const eligible = snapshot.candidates.find((c) => c.eligibility.eligible
    && c.eligibility.origin.deviceId === candidate.deviceId
    && c.eligibility.origin.contextKey === candidate.contextKey
    && c.eligibility.families.includes(candidate.family));
  if (!eligible) {
    const reasons = snapshot.candidates.flatMap((c) => c.eligibility.reasons);
    return { reason: reasons[0] ?? 'no_eligible_collector' };
  }
  const origin = eligible.eligibility.origin;
  return {
    context: {
      contextKey: origin.contextKey,
      family: candidate.family,
      originDeviceId: origin.deviceId,
      originNodeId: origin.nodeId,
      sourceId: origin.sourceId,
      interfaceId: origin.interfaceId,
      interfaceEpoch: origin.interfaceEpoch,
    },
  };
}

export async function resolvePolicyRoutingContexts(
  ctx: TopologyRequestContext,
  definition: TopologyPolicyDefinition,
  requested: TopologyPolicyArmRequest['contexts'],
  repository: DiagnosticPlanningRepository = topologyDiagnosticRepository,
): Promise<TopologyPolicyRoutingContext[]> {
  const candidates = await routingContextCandidates(ctx, definition.families);
  const bound: TopologyPolicyRoutingContext[] = [];
  if (requested) {
    for (const wanted of requested) {
      if (!definition.families.includes(wanted.family)) throw new TopologyOperationError('context_family_not_configured', 409);
      const matches = candidates.filter((c) => c.contextKey === wanted.contextKey && c.family === wanted.family);
      let lastReason = 'context_not_observed';
      let done = false;
      for (const match of matches) {
        const result = await bindRoutingContext(ctx, definition, match, repository);
        if ('context' in result) { bound.push(result.context); done = true; break; }
        lastReason = result.reason;
      }
      if (!done) throw new TopologyOperationError(lastReason, 409, `Context ${wanted.contextKey}/${wanted.family} is not eligible`);
    }
  } else {
    const keys = new Set<string>();
    for (const candidate of candidates) {
      if (bound.some((b) => b.contextKey === candidate.contextKey && b.family === candidate.family)) continue;
      if (!keys.has(candidate.contextKey) && keys.size >= TOPOLOGY_POLICY_DEFAULT_CONTEXTS) continue;
      const result = await bindRoutingContext(ctx, definition, candidate, repository);
      if ('context' in result) { bound.push(result.context); keys.add(candidate.contextKey); }
    }
    if (!bound.length) throw new TopologyOperationError('no_eligible_collector', 409, 'No eligible collector observes a routing context for this policy');
  }
  return topologyPolicyRoutingContextsSchema.parse(bound);
}

/**
 * Re-key the runtime streak state for a new arm (M3 Task 7): pairs that remain
 * keep their active alert reference but restart counters and continuity under
 * the new policy revision; pairs that are gone stop executing without closing
 * any historical alert.
 */
export function rearmAlertState(previous: unknown, contexts: ReadonlyArray<TopologyPolicyRoutingContext>, policyRevision: string): TopologyPolicyAlertState {
  const parsed = topologyPolicyAlertStateSchema.safeParse(previous);
  const old = parsed.success ? parsed.data.entries : [];
  return topologyPolicyAlertStateSchema.parse({
    schemaVersion: 1,
    entries: contexts.map((c) => {
      const kept = old.find((e) => e.contextKey === c.contextKey && e.family === c.family);
      return {
        contextKey: c.contextKey,
        family: c.family,
        policyRevision,
        lastClaimedScheduledFor: null,
        lastClaimedOccurrenceKey: null,
        lastAppliedScheduledFor: null,
        lastAppliedOccurrenceKey: null,
        continuityKey: null,
        originDeviceId: null,
        originAgentId: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        activeAlertId: kept?.activeAlertId ?? null,
        lastNotifiedAt: kept?.lastNotifiedAt ?? null,
      };
    }),
  });
}

async function lockPolicy(ctx: TopologyRequestContext, policyId: string): Promise<PolicyRow> {
  if (!/^[0-9a-f-]{36}$/i.test(policyId)) throw notFound();
  const [row] = await db
    .select()
    .from(topologyMonitoringPolicies)
    .where(and(scopedWrite(ctx.scope, topologyMonitoringPolicies), eq(topologyMonitoringPolicies.id, policyId), isNull(topologyMonitoringPolicies.deletedAt)))
    .for('update');
  if (!row) throw notFound();
  return row;
}

export type ArmTopologyPolicyDeps = {
  repository?: DiagnosticPlanningRepository;
  freezeAuthority?: (ctx: TopologyRequestContext) => Promise<TopologyArmAuthorityRecord>;
  now?: () => Date;
  /** Consumes the single-use step-up grant inside the arm transaction; throws to roll the arm back. */
  consumeStepUp?: () => Promise<void>;
};

/**
 * Arm one compiled policy (M3 Task 7). Human-only and MFA-satisfied (the route
 * additionally demands a fresh step-up grant); requires `configure` and
 * `execute` on the exact site, the materialization + diagnostics flags, the
 * policy's activation intent and unchanged pinned targets. The arm pins the
 * routing contexts, the frozen actor and the effect digest in one CAS write.
 */
export async function armTopologyMonitoringPolicy(
  ctx: TopologyRequestContext,
  policyId: string,
  request: TopologyPolicyArmRequest,
  deps: ArmTopologyPolicyDeps = {},
): Promise<TopologyPolicyArmState> {
  requireHumanArmingSession(ctx);
  expectedRevisionSchema.parse(request.expectedRevision);
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'configure');
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'execute');
  // Flags first: the partner-axis read may use a second pooled connection and
  // must never wait while this transaction holds the policy row lock.
  const flags = await loadTopologyFlags(ctx);
  if (!flags.materialization || !flags.diagnostics) throw new TopologyOperationError('diagnostics_disabled', 409);
  const authority = await (deps.freezeAuthority ?? freezeTopologyArmAuthority)(ctx);
  const now = (deps.now ?? (() => new Date()))();

  return withDbTransaction(async () => {
    const row = await lockPolicy(ctx, policyId);
    if (row.revision.toString() !== request.expectedRevision) throw new TopologyOperationError('revision_conflict', 409);
    if (!row.activationIntent) throw new TopologyOperationError('activation_intent_required', 409, 'Enable the policy in site settings before arming it');
    const definition = row.definition as TopologyPolicyDefinition;
    const { pins, drift } = await loadPolicyTargetPins(ctx.scope, row.id);
    if (drift) throw new TopologyOperationError(drift, 409);
    if (definition.recipeId !== 'gateway_basic' && pins.length === 0) throw new TopologyOperationError('target_not_configured', 409);
    const contexts = await resolvePolicyRoutingContexts(ctx, definition, request.contexts, deps.repository);
    const nextRevision = (row.revision + 1n).toString();
    const authorityDigest = topologyPolicyEffectDigest({
      scope: ctx.scope,
      policyId: row.id,
      definition,
      targets: pins,
      contexts,
      authority: {
        userId: authority.actor.user.id,
        authEpoch: authority.actor.authEpoch,
        mfaEpoch: authority.actor.mfaEpoch,
        permissionVersion: authority.permissionVersion,
      },
    });
    const alertState = rearmAlertState(row.alertState, contexts, nextRevision);
    const [updated] = await db
      .update(topologyMonitoringPolicies)
      .set({
        enabled: true,
        blockedReason: null,
        requesterId: authority.actor.user.id,
        authorityActor: authority as unknown as Record<string, unknown>,
        authorityPermissionVersion: authority.permissionVersion,
        authorityDigest,
        authorityGeneration: sql`${topologyMonitoringPolicies.authorityGeneration}+1`,
        armedAt: now,
        routingContexts: contexts,
        revision: sql`${topologyMonitoringPolicies.revision}+1`,
        alertState,
        alertStateRevision: sql`${topologyMonitoringPolicies.alertStateRevision}+1`,
        nextScheduledAt: nextTopologyPolicyDueAt(row.id, definition.intervalSeconds, now),
        updatedAt: now,
      })
      .where(and(eq(topologyMonitoringPolicies.id, row.id), eq(topologyMonitoringPolicies.revision, row.revision)))
      .returning();
    if (!updated) throw new TopologyOperationError('revision_conflict', 409);
    await deps.consumeStepUp?.();
    await db.insert(auditLogs).values({
      orgId: ctx.scope.orgId,
      actorType: 'user',
      actorId: ctx.auth.user.id,
      actorEmail: ctx.auth.user.email,
      action: 'topology.monitoring_policy.armed',
      resourceType: 'topology_monitoring_policy',
      resourceId: row.id,
      result: 'success',
      details: { siteId: ctx.scope.siteId, revision: updated.revision.toString(), authorityDigest, contexts: contexts.map((c) => `${c.contextKey}/${c.family}`) },
    });
    return topologyPolicyArmView(updated);
  });
}

/** Disarming only reduces authority: `configure` on the site, no step-up. Queued scheduled runs of the policy stop. */
export async function disarmTopologyMonitoringPolicy(
  ctx: TopologyRequestContext,
  policyId: string,
  expectedRevision: string,
  reason = 'disarmed',
): Promise<TopologyPolicyArmState> {
  expectedRevisionSchema.parse(expectedRevision);
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'configure');
  return withDbTransaction(async () => {
    const row = await lockPolicy(ctx, policyId);
    if (row.revision.toString() !== expectedRevision) throw new TopologyOperationError('revision_conflict', 409);
    const updated = await disarmPolicyRow(ctx.scope, row, reason);
    await db.insert(auditLogs).values({
      orgId: ctx.scope.orgId,
      actorType: 'user',
      actorId: ctx.auth.user.id,
      actorEmail: ctx.auth.user.email,
      action: 'topology.monitoring_policy.disarmed',
      resourceType: 'topology_monitoring_policy',
      resourceId: row.id,
      result: 'success',
      details: { siteId: ctx.scope.siteId, reason },
    });
    return topologyPolicyArmView(updated);
  });
}

/** Site state must exist before any arm; a pristine site is still preparing. */
export async function requireTopologySiteState(scope: TopologyRequestContext['scope']): Promise<void> {
  const [state] = await db.select({ orgId: topologySiteState.orgId }).from(topologySiteState).where(scopedWrite(scope, topologySiteState)).limit(1);
  if (!state) throw new TopologyOperationError('topology_preparing', 409);
}
