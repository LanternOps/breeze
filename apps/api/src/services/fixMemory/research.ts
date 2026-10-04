// apps/api/src/services/fixMemory/research.ts
/**
 * AI Suggested Fixes W2 — the one entry point that starts research (manual
 * Generate / "Research deeper", and auto research for high/critical alerts
 * with nothing attached). Everything cost-bearing funnels through
 * createAndEnqueueAgentRun (kill switch, circuit, caps, daily budget); this
 * layer adds what admission cannot know: per-(source, depth) dedupe with an
 * explicit manual retry and a denial CODE the panel can render (spec "Error
 * handling": never a silent empty state). The auto-research hourly cap is
 * admission rule 6c, evaluated under admission's (agent, org) advisory lock.
 *
 * DB CONTEXT CONTRACT (#2417 / #6671 / #7187 — sequential, never nested):
 *  - The caller must hold NO DB context; this is asserted. A route calling it
 *    is registered in SELF_MANAGED_DB_CONTEXT_ROUTES.
 *  - All of this function's own reads (flag, source + org pin, dedupe, partner)
 *    run in ONE `runReads` call that returns a plain object and commits. The
 *    caller picks the context: routes pass `withAuthDbAccessContext(auth, …)`
 *    (RLS-scoped: another org's source is simply not found); background callers
 *    pass `inSystemDbContext` (every predicate here is org-pinned).
 *  - Then, with nothing held: `ensureResearchAgent` (its own short system tx)
 *    and `createAndEnqueueAgentRun`, whose admission system tx therefore opens
 *    fresh and COMMITS before its step-10 BullMQ enqueue — the worker never
 *    sees a job for an uncommitted ai_agent_runs row.
 */
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { AiAgentRunStatus, ResearchDepth } from '@breeze/shared';
import { db, hasDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { alertCorrelationGroups, alerts, metricAnomalies } from '../../db/schema';
import { ensureResearchAgent, ResearchBaselineConflictError } from '../aiAgents/researchProvisioning';
import { createAndEnqueueAgentRun, type AgentRunSkipReason } from '../aiAgents/runService';
import { checkBudgetDetailed, type AiBillingSource, type AiDenialReason } from '../aiCostTracker';
import { shouldProduceMlOutput } from '../mlFeatureFlags';
import { resolveOrgPartnerId } from './catalog';

export type ResearchTrigger = 'manual' | 'auto';
export type ResearchDenialCode =
  | AiDenialReason | AgentRunSkipReason | 'flag_off' | 'source_not_found' | 'no_device' | 'auto_cap' | 'permission' | 'research_unavailable'
  | 'research_baseline_not_system_provisioned';
export type ResearchRequestResult =
  | { status: 'started' | 'already_running' | 'already_done'; runId: string; depth: ResearchDepth }
  | { status: 'denied'; code: ResearchDenialCode; message: string };

type SourceType = 'alert' | 'anomaly' | 'correlation';
const ACTIVE = new Set<AiAgentRunStatus>(['queued', 'running', 'awaiting_approval']);

export function researchDedupeBase(sourceType: string, sourceId: string, depth: ResearchDepth): string {
  return `research:${sourceType}:${sourceId}:${depth}`;
}

async function sourceTarget(orgId: string, sourceType: SourceType, sourceId: string):
  Promise<{ deviceId: string | null; alertId: string | null; correlationGroupId: string | null } | null> {
  if (sourceType === 'alert') {
    const [a] = await db.select({ deviceId: alerts.deviceId }).from(alerts)
      .where(and(eq(alerts.id, sourceId), eq(alerts.orgId, orgId))).limit(1);
    return a ? { deviceId: a.deviceId, alertId: sourceId, correlationGroupId: null } : null;
  }
  if (sourceType === 'anomaly') {
    const [m] = await db.select({ deviceId: metricAnomalies.deviceId }).from(metricAnomalies)
      .where(and(eq(metricAnomalies.id, sourceId), eq(metricAnomalies.orgId, orgId))).limit(1);
    return m ? { deviceId: m.deviceId, alertId: null, correlationGroupId: null } : null;
  }
  const [g] = await db.select({ rootAlertId: alertCorrelationGroups.rootAlertId, deviceId: alerts.deviceId })
    .from(alertCorrelationGroups)
    .innerJoin(alerts, eq(alerts.id, alertCorrelationGroups.rootAlertId))
    .where(and(eq(alertCorrelationGroups.id, sourceId), eq(alertCorrelationGroups.orgId, orgId))).limit(1);
  return g ? { deviceId: g.deviceId, alertId: g.rootAlertId, correlationGroupId: sourceId } : null;
}

/** Device of a research source (RLS-scoped, org-filtered), for callers' site-scope checks. null = source not found. */
export async function researchSourceDeviceId(input: { orgId: string; sourceType: SourceType; sourceId: string }): Promise<{ deviceId: string | null } | null> {
  const target = await sourceTarget(input.orgId, input.sourceType, input.sourceId);
  return target ? { deviceId: target.deviceId } : null;
}

const denied = (code: ResearchDenialCode, message: string): ResearchRequestResult => ({ status: 'denied', code, message });

/** Runs `fn` in a short DB context that commits when it returns (see the file header). */
export type ResearchReadRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export interface ResearchRequestInput {
  orgId: string; sourceType: SourceType; sourceId: string; depth: ResearchDepth; trigger: ResearchTrigger; actorUserId: string | null;
  runReads: ResearchReadRunner;
}

type ResearchPlan =
  | { kind: 'answered'; result: ResearchRequestResult }
  | { kind: 'admit'; partnerId: string; dedupeKey: string; target: { deviceId: string; alertId: string | null; correlationGroupId: string | null } };

/** Every read requestResearch makes before admission. Runs inside `runReads`; returns plain data only. */
async function planResearch(input: ResearchRequestInput): Promise<ResearchPlan> {
  const answered = (result: ResearchRequestResult): ResearchPlan => ({ kind: 'answered', result });
  if (!(await shouldProduceMlOutput(input.orgId, 'ml.remediation_suggestions.enabled'))) {
    return answered(denied('flag_off', 'Suggested fixes are off for this organization.'));
  }
  const target = await sourceTarget(input.orgId, input.sourceType, input.sourceId);
  if (!target) return answered(denied('source_not_found', 'The alert or anomaly no longer exists.'));
  if (!target.deviceId) return answered(denied('no_device', 'Research needs exactly one device.'));

  const base = researchDedupeBase(input.sourceType, input.sourceId, input.depth);
  const [latest] = await db.select({ id: aiAgentRuns.id, status: aiAgentRuns.status }).from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, input.orgId), like(aiAgentRuns.dedupeKey, `${base}%`)))
    .orderBy(desc(aiAgentRuns.queuedAt)).limit(1);
  let dedupeKey = base;
  if (latest) {
    if (ACTIVE.has(latest.status)) return answered({ status: 'already_running', runId: latest.id, depth: input.depth });
    // NOTE: an auto request over a failed/cancelled run also reports already_done
    // (auto never retries); callers must read the run's status, not trust the label.
    if (latest.status === 'completed' || input.trigger === 'auto') return answered({ status: 'already_done', runId: latest.id, depth: input.depth });
    const [{ value: prior } = { value: 0 }] = await db.select({ value: sql<number>`count(*)::int` }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, input.orgId), like(aiAgentRuns.dedupeKey, `${base}%`)));
    dedupeKey = `${base}:retry-${prior}`;
  }

  const partnerId = await resolveOrgPartnerId(input.orgId);
  if (!partnerId) return answered(denied('source_not_found', 'Organization not found.'));
  return { kind: 'admit', partnerId, dedupeKey, target: { deviceId: target.deviceId, alertId: target.alertId, correlationGroupId: target.correlationGroupId } };
}

export async function requestResearch(input: ResearchRequestInput): Promise<ResearchRequestResult> {
  if (hasDbAccessContext()) {
    // Provisioning and admission each open their own system transaction; under a
    // held one that is a second pooled connection (pool deadlock at concurrency
    // >= pool size) and an enqueue of a row that has not committed yet.
    throw new Error('requestResearch must be called with no DB context held (register the route in SELF_MANAGED_DB_CONTEXT_ROUTES and pass runReads)');
  }
  const plan = await input.runReads(() => planResearch(input));
  if (plan.kind === 'answered') return plan.result;
  const { partnerId, dedupeKey, target } = plan;

  // Provision BEFORE admission: the effective research policy (and so the auto
  // cap admission evaluates) does not exist until the partner baseline does
  // (effectivePolicy.ts). Opens and commits its own system transaction.
  try {
    await ensureResearchAgent(partnerId);
  } catch (err) {
    // A non-system-provisioned partner research row is never adopted.
    if (err instanceof ResearchBaselineConflictError) {
      return denied(err.code, 'This partner already has a research agent that was not provisioned by the system, so automatic research is unavailable.');
    }
    throw err;
  }

  // Funding is captured from admission itself (the effective policy's pinned
  // offering included), never re-resolved here, so the credit/budget denial
  // detail below cannot disagree with what admission actually used.
  // No ambient context here (asserted above), so admission's inSystemDbContext
  // opens a fresh transaction that commits before announceAndEnqueueAgentRun
  // runs: the enqueue is after-commit without deferEnqueue.
  const funding: { value: AiBillingSource | null } = { value: null };
  const result = await createAndEnqueueAgentRun({
    orgId: input.orgId,
    kind: 'research',
    profile: 'remediation_research',
    triggerKind: input.trigger === 'auto' ? 'alert' : 'manual',
    deviceId: target.deviceId,
    alertId: target.alertId ?? undefined,
    correlationGroupId: target.correlationGroupId ?? undefined,
    dedupeKey,
    triggerRef: { depth: input.depth, sourceType: input.sourceType, sourceId: input.sourceId, requestedByUserId: input.actorUserId },
  }, { onFundingResolved: (f) => { funding.value = f; } });
  if (!result.created) {
    if (result.skipped === 'duplicate') {
      const [dup] = await input.runReads(() => db.select({ id: aiAgentRuns.id, status: aiAgentRuns.status }).from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.orgId, input.orgId), eq(aiAgentRuns.dedupeKey, dedupeKey))).limit(1));
      if (dup) {
        return { status: ACTIVE.has(dup.status) ? 'already_running' : 'already_done', runId: dup.id, depth: input.depth };
      }
    }
    if (result.skipped === 'org_budget_exceeded' && funding.value) {
      // Name the real reason (credits exhausted vs daily/monthly budget). Opens its own system contexts.
      const denial = await checkBudgetDetailed(input.orgId, funding.value);
      if (denial) return denied(denial.reason, denial.message);
    }
    if (result.skipped === 'research_auto_cap') {
      return denied('auto_cap', 'Automatic research has reached its hourly limit for this organization.');
    }
    return denied(result.skipped, `Research was not started (${result.skipped}).`);
  }
  return { status: 'started', runId: result.run.id, depth: input.depth };
}

export interface ResearchStatus {
  runId: string; depth: ResearchDepth; status: AiAgentRunStatus; errorCode: string | null; noSafeFix: boolean; finishedAt: string | null;
}

export async function researchStatusForSource(input: { orgId: string; sourceType: string; sourceId: string }): Promise<ResearchStatus | null> {
  const [row] = await db.select({
    id: aiAgentRuns.id, status: aiAgentRuns.status, errorCode: aiAgentRuns.errorCode, outcome: aiAgentRuns.outcome,
    triggerRef: aiAgentRuns.triggerRef, finishedAt: aiAgentRuns.finishedAt,
  }).from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, input.orgId), like(aiAgentRuns.dedupeKey, `research:${input.sourceType}:${input.sourceId}:%`)))
    .orderBy(desc(aiAgentRuns.queuedAt)).limit(1);
  if (!row) return null;
  const research = (row.outcome as { research?: { noSafeFix?: boolean } } | null)?.research;
  return {
    runId: row.id,
    depth: (row.triggerRef as { depth?: unknown })?.depth === 'deep' ? 'deep' : 'quick',
    status: row.status,
    errorCode: row.errorCode ?? null,
    noSafeFix: row.status === 'completed' && research?.noSafeFix === true,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
  };
}
