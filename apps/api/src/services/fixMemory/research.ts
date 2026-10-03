// apps/api/src/services/fixMemory/research.ts
/**
 * AI Suggested Fixes W2 — the one entry point that starts research (manual
 * Generate / "Research deeper", and auto research for high/critical alerts
 * with no proven fix). Everything cost-bearing funnels through
 * createAndEnqueueAgentRun (kill switch, circuit, caps, daily budget); this
 * layer adds what admission cannot know: per-(source, depth) dedupe with an
 * explicit manual retry, the auto-research hourly cap, and a denial CODE the
 * panel can render (spec "Error handling": never a silent empty state).
 *
 * DB CONTEXT: called from inside the route's request `withDbAccessContext`
 * transaction. Its own reads (source lookup, dedupe, latest run) are therefore
 * RLS-scoped, which is the tenancy backstop: another org's source is simply
 * not found. Its inner system-context calls (`ensureResearchAgent`,
 * `createAndEnqueueAgentRun`) follow the existing POST /ai-agents/:id/runs
 * precedent, which calls `createAndEnqueueAgentRun` (an `inSystemDbContext`)
 * from inside the request. Provisioning is done here, before admission.
 */
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { AiAgentRunStatus, ResearchDepth } from '@breeze/shared';
import { db } from '../../db';
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

export async function requestResearch(input: {
  orgId: string; sourceType: SourceType; sourceId: string; depth: ResearchDepth; trigger: ResearchTrigger; actorUserId: string | null;
}): Promise<ResearchRequestResult> {
  if (!(await shouldProduceMlOutput(input.orgId, 'ml.remediation_suggestions.enabled'))) {
    return denied('flag_off', 'Suggested fixes are off for this organization.');
  }
  const target = await sourceTarget(input.orgId, input.sourceType, input.sourceId);
  if (!target) return denied('source_not_found', 'The alert or anomaly no longer exists.');
  if (!target.deviceId) return denied('no_device', 'Research needs exactly one device.');

  const base = researchDedupeBase(input.sourceType, input.sourceId, input.depth);
  const [latest] = await db.select({ id: aiAgentRuns.id, status: aiAgentRuns.status }).from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, input.orgId), like(aiAgentRuns.dedupeKey, `${base}%`)))
    .orderBy(desc(aiAgentRuns.queuedAt)).limit(1);
  let dedupeKey = base;
  if (latest) {
    if (ACTIVE.has(latest.status)) return { status: 'already_running', runId: latest.id, depth: input.depth };
    // NOTE: an auto request over a failed/cancelled run also reports already_done
    // (auto never retries); callers must read the run's status, not trust the label.
    if (latest.status === 'completed' || input.trigger === 'auto') return { status: 'already_done', runId: latest.id, depth: input.depth };
    const [{ value: prior } = { value: 0 }] = await db.select({ value: sql<number>`count(*)::int` }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, input.orgId), like(aiAgentRuns.dedupeKey, `${base}%`)));
    dedupeKey = `${base}:retry-${prior}`;
  }

  // Provision BEFORE admission and before any model/policy resolution: the effective research policy (and so the
  // auto cap admission evaluates) does not exist until the partner baseline
  // does (effectivePolicy.ts:515). The auto-research hourly cap is evaluated
  // inside admission's (agent, org) advisory lock, not here (Codex 5, 6).
  const partnerId = await resolveOrgPartnerId(input.orgId);
  if (!partnerId) return denied('source_not_found', 'Organization not found.');
  try {
    await ensureResearchAgent(partnerId);
  } catch (err) {
    // A non-system-provisioned partner research row is never adopted (Task 6).
    if (err instanceof ResearchBaselineConflictError) {
      return denied(err.code, 'This partner already has a research agent that was not provisioned by the system, so automatic research is unavailable.');
    }
    throw err;
  }

  // Funding is captured from admission itself (the effective policy's pinned
  // offering included), never re-resolved here, so the credit/budget denial
  // detail below cannot disagree with what admission actually used.
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
      const [dup] = await db.select({ id: aiAgentRuns.id, status: aiAgentRuns.status }).from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.orgId, input.orgId), eq(aiAgentRuns.dedupeKey, dedupeKey))).limit(1);
      if (dup) {
        return { status: ACTIVE.has(dup.status) ? 'already_running' : 'already_done', runId: dup.id, depth: input.depth };
      }
    }
    if (result.skipped === 'org_budget_exceeded' && funding.value) {
      // Name the real reason (credits exhausted vs daily/monthly budget).
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
