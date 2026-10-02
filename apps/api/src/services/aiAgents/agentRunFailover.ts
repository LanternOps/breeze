/**
 * AI model registry W09 (#7607): the run loop's failover hop. A run fails
 * over only on a PRE-OUTPUT provider failure (runLoop.ts decides that); this
 * module re-resolves the run's role with every tried offering excluded,
 * admits the next hop's funding (credits on platform, caps on both), and
 * records the hop on the run BEFORE its reservation exists, so a re-driven
 * run resumes on the same hop key and can never reserve a hop twice.
 *
 * Order on a failover (Codex review 5): record hop n here, THEN the loop
 * settles hop n-1. A crash in between leaves hop n-1's reservation active
 * while the run row already names hop n; `markStaleHopReservations` closes
 * that window on re-drive.
 */
import { and, eq } from 'drizzle-orm';
import type { AiAgentEscalationRole } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiBudgetReservations } from '../../db/schema/ai';
import { markAiBudgetReservationIndeterminate } from '../aiBudgetReservations';
import { checkBudgetDetailed, type AiBillingSource } from '../aiCostTracker';
import { hopIdempotencyKey, MAX_FAILOVER_HOP, type FailoverCause, type ProviderFailureCause } from '../aiModels/failover';
import { resolveModel, type FailoverOrigin, type ResolvedModel } from '../aiModels/resolveModel';

/** Same skip-if-already-system shape as runLoop's `inSystemDbContext`: never take a second pooled connection. */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** The reservation key every agent-run hop derives from (hop 0 = W03's key). */
export function agentRunReservationBaseKey(runId: string): string {
  return `ai-agent-run:${runId}`;
}

/**
 * The served hop, written together (ai_agent_runs_served_chk: all four or
 * none). `served_funding_source` is the TOKEN funding; compute stays on the
 * admitted `funding_source` (D7).
 */
export async function recordServedHop(
  runId: string,
  served: { offeringId: string; funding: AiBillingSource; hop: number; cause: FailoverCause },
): Promise<void> {
  await inSystemDbContext(() => db
    .update(aiAgentRuns)
    .set({
      servedOfferingId: served.offeringId,
      servedFundingSource: served.funding,
      servedFailoverHop: served.hop,
      servedFailoverCause: served.cause,
    })
    .where(eq(aiAgentRuns.id, runId)));
}

/**
 * Codex review 5: an earlier hop whose reservation is still ACTIVE was
 * dispatched but never settled (the process died between recording the next
 * hop and settling this one). Its provider outcome is unknown, so it is
 * marked indeterminate (W03's unknown-outcome state: it keeps holding
 * capacity for the indeterminate window). It is never re-reserved, and never
 * debited at a guessed amount. Settled / released / expired hops are left
 * alone. Returns how many it marked.
 */
export async function markStaleHopReservations(input: { runId: string; orgId: string; uptoHop: number }): Promise<number> {
  const base = agentRunReservationBaseKey(input.runId);
  let marked = 0;
  for (let n = 0; n < Math.min(input.uptoHop, MAX_FAILOVER_HOP + 1); n++) {
    const key = hopIdempotencyKey(base, n);
    const [row] = await inSystemDbContext(() => db
      .select({ id: aiBudgetReservations.id, status: aiBudgetReservations.status })
      .from(aiBudgetReservations)
      .where(and(eq(aiBudgetReservations.orgId, input.orgId), eq(aiBudgetReservations.idempotencyKey, key)))
      .limit(1));
    if (row?.status === 'active') {
      await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId: row.id });
      marked++;
    }
  }
  return marked;
}

export type NextAgentHop =
  | { ok: true; resolved: ResolvedModel }
  | { ok: false; reason: 'no_next_hop' | 'admission_denied'; message: string };

const NO_OTHER_MODEL = 'No other AI model is available for this agent.';

export interface AgentHopProbeInput {
  orgId: string;
  partnerId: string;
  role: AiAgentEscalationRole;
  requestedOfferingId: string | null;
  tried: readonly string[];
  cause: ProviderFailureCause;
  /** The hop being opened (1..MAX_FAILOVER_HOP). */
  hop: number;
  /** The run's first hop (its admitted offering and funding): F1 is judged against it. */
  origin: FailoverOrigin;
}

/**
 * PR #7775 review: the side-effect-free half of `nextAgentHop`. The run loop
 * asks this BEFORE aborting the CLI's own retries, so a run with a fallback
 * list but no usable backup (crossing off, permitted set, ineligible, cooling,
 * funding not admitted) keeps W03's behaviour instead of failing
 * `llm_unavailable`. Reads only: it never records the hop on the run.
 */
export async function probeAgentHop(input: AgentHopProbeInput): Promise<NextAgentHop> {
  if (!Number.isInteger(input.hop) || input.hop < 1 || input.hop > MAX_FAILOVER_HOP) {
    return { ok: false, reason: 'no_next_hop', message: NO_OTHER_MODEL };
  }
  const next = await resolveModel({
    partnerId: input.partnerId,
    orgId: input.orgId,
    surface: 'ai_agents',
    role: input.role,
    ...(input.requestedOfferingId ? { requested: { offeringId: input.requestedOfferingId, origin: 'policy' as const } } : {}),
    excludeOfferingIds: input.tried,
    failoverCause: input.cause,
    failoverOrigin: input.origin,
  });
  if (!next.ok) return { ok: false, reason: 'no_next_hop', message: next.message };
  if (!next.offering.id || input.tried.includes(next.offering.id)) {
    return { ok: false, reason: 'no_next_hop', message: NO_OTHER_MODEL };
  }
  // F3: the next hop's OWN funding is admitted (credits on platform, caps on both) before anything is recorded.
  const denial = await checkBudgetDetailed(input.orgId, next.funding);
  if (denial) return { ok: false, reason: 'admission_denied', message: denial.message };
  return { ok: true, resolved: next };
}

/** Probe, then RECORD the hop on the run (before its reservation exists: re-drive resumes on it). */
export async function nextAgentHop(input: AgentHopProbeInput & { runId: string }): Promise<NextAgentHop> {
  const next = await probeAgentHop(input);
  if (!next.ok) return next;
  await recordServedHop(input.runId, {
    offeringId: next.resolved.offering.id!, funding: next.resolved.funding, hop: input.hop, cause: input.cause,
  });
  return next;
}

/** Re-drive: a run resumes on the hop it last recorded; a fresh run starts at hop 0 on its admitted offering. */
export function startHopFor(run: {
  servedOfferingId?: string | null;
  servedFailoverHop?: number | null;
  admittedOfferingId?: string | null;
}): { requestedOfferingId: string | null; hop: number } {
  if (run.servedOfferingId && run.servedFailoverHop) {
    return { requestedOfferingId: run.servedOfferingId, hop: run.servedFailoverHop };
  }
  return { requestedOfferingId: run.admittedOfferingId ?? null, hop: 0 };
}
