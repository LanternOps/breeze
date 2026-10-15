/**
 * #7787: an agent run's failover provenance as of ADMISSION.
 *
 * Admission resolves the run's model (runService step 3d). When the primary
 * is cooling or ineligible, the resolver walks straight to a fallback and
 * admission admits THAT offering. Chat records the same situation on its
 * ledger row (failover_hop / failover_cause / failover_from_offering_id); an
 * agent run must too. Admission stamps the resolver's provenance on the run's
 * served_* columns with served = admitted, and the run loop copies it onto
 * the hop-0 ledger row. It is provenance only: the run stays on hop 0's
 * reservation key (`startHopFor`).
 *
 * Dependency-free on purpose: runService loads the resolver's module graph
 * lazily, so this file imports types and constants only.
 */
import { MAX_FAILOVER_HOP, FAILOVER_CAUSES, type FailoverCause } from '../aiModels/failover';
import type { ResolvedModel } from '../aiModels/resolveModel';

/**
 * #7787: the run's failover provenance as of ADMISSION, columns -> values.
 * Admission resolved straight to a fallback (its primary was cooling or
 * ineligible) and admitted THAT offering. Chat records the same situation on
 * its ledger row; an agent run must too. Null when admission served its primary.
 */
export function admissionServedColumns(resolved: Pick<ResolvedModel, 'offering' | 'funding' | 'failover'>): {
  servedOfferingId: string | null;
  servedFundingSource: ResolvedModel['funding'] | null;
  servedFailoverHop: number | null;
  servedFailoverCause: FailoverCause | null;
  servedFailoverFromOfferingId: string | null;
} {
  const f = resolved.failover;
  // ai_agent_runs_served_chk: hop 1..MAX_FAILOVER_HOP, all four or none.
  if (!f || !resolved.offering.id || !Number.isInteger(f.hop) || f.hop < 1 || f.hop > MAX_FAILOVER_HOP) {
    return {
      servedOfferingId: null, servedFundingSource: null, servedFailoverHop: null,
      servedFailoverCause: null, servedFailoverFromOfferingId: null,
    };
  }
  return {
    servedOfferingId: resolved.offering.id,
    servedFundingSource: resolved.funding,
    servedFailoverHop: f.hop,
    servedFailoverCause: f.cause,
    servedFailoverFromOfferingId: f.fromOfferingId,
  };
}

/**
 * #7787: served_* naming the ADMITTED offering are admission's provenance,
 * not a run-loop hop (a run-loop hop never re-serves the admitted offering:
 * it is always in `tried`). They are recorded on the hop-0 ledger row only;
 * the reservation key stays hop 0's.
 */
export function admissionFailoverOf(run: {
  admittedOfferingId?: string | null;
  servedOfferingId?: string | null;
  servedFailoverHop?: number | null;
  servedFailoverCause?: string | null;
  servedFailoverFromOfferingId?: string | null;
}): { fromOfferingId: string | null; hop: number; cause: FailoverCause } | null {
  if (!run.servedOfferingId || run.servedOfferingId !== run.admittedOfferingId) return null;
  const hop = run.servedFailoverHop;
  const cause = run.servedFailoverCause;
  if (!hop || hop < 1 || hop > MAX_FAILOVER_HOP) return null;
  if (!cause || !(FAILOVER_CAUSES as readonly string[]).includes(cause)) return null;
  return { fromOfferingId: run.servedFailoverFromOfferingId ?? null, hop, cause: cause as FailoverCause };
}
