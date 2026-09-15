// apps/api/src/services/aiAgents/sweepActCohort.ts
/**
 * #4442 W05 §3.5 — the deterministic canary cohort: how far ONE sweep
 * occurrence may reach unattended.
 *
 * This module is PURE. It performs no IO, takes no lock and reserves nothing.
 * It answers one question — "which of this occurrence's act-eligible proposals
 * may be minted act-eligible without over-subscribing the exposure ledger?" —
 * and the caller (`persistSweepFindings`) passes `sweepAct` only for the
 * admitted prefix. Every other proposal is minted EXACTLY as it is today: an
 * ordinary supervised approval card. Nothing is ever dropped; the cohort
 * decides act-ELIGIBILITY, not existence.
 *
 * ## Why a readiness check and not a reservation
 *
 * The first spec draft reserved M `ai_unattended_exposure` rows at fan-out
 * under a new `source: 'sweep_fanout'`. The quorum rejected it and the
 * rejection is load-bearing:
 *
 *  - a `sweep_fanout` row is excluded from the day count, which filters
 *    `source = 'policy_intent'` (`exposureBudget.ts`);
 *  - `runAuthorizeTransaction` would insert its OWN reservation anyway and
 *    attach that id (`policyDecide.ts`), so the pre-reservation would double
 *    count; and
 *  - a fan-out rollback cannot undo rows a prior transaction committed.
 *
 * Each intent's own `attemptPolicyDecision` therefore still performs the
 * single, idempotent reservation exactly as before. This walk only bounds
 * over-subscription.
 *
 * ## The arithmetic is NOT a running sum
 *
 * Mirrors `exposureBudget.ts` exactly:
 *
 *  - the FLEET cap compares `|existing ∪ candidate devices|` against
 *    `floor(contractDeviceCount * maxFleetPercentPerDay / 100)` — a set union,
 *    never `existingCount + N`. A candidate on a device already inside the
 *    24 h window costs the union nothing.
 *  - there is **no `max(1, ·)`**: a fleet too small for one whole device's
 *    allowance gets ZERO unattended authorizations. Locked quorum decision,
 *    not a rounding bug.
 *  - the DAY cap counts `source = 'policy_intent'` ROWS per `(org, agent)` in
 *    the trailing 24 h, i.e. ACTIONS. Two proposals on one device consume ONE
 *    device slot but TWO day slots.
 *
 * ## Deterministic prefix, never iteration order
 *
 * The order is `(severity desc, kind asc, deviceId asc, subjectKey asc)` —
 * documented here, tested directly, stable across re-runs, and never the
 * model's array order. All-or-nothing was rejected on starvation: a 40-device
 * fleet at the 5 % default permits 2 devices, so an org with 3 persistent
 * eligible targets would never act at all, silently and forever.
 *
 * ## Not an atomic-execution promise
 *
 * A cohort member can still lose the authorize race or fail decide-time
 * revalidation and degrade to `human_required` on its own. This is a bound on
 * how many may TRY, not a guarantee that they all succeed.
 */
import { AI_SWEEP_SEVERITIES, type AiSweepKind, type AiSweepSeverity } from '@breeze/shared';

export interface CohortCandidate {
  findingIndex: number;
  deviceId: string;
  severity: AiSweepSeverity;
  kind: AiSweepKind;
  subjectKey: string;
}

/** Which cap ended the walk — surfaced so the run detail can explain itself. */
export type CohortStopReason = 'fleet_cap' | 'day_cap' | 'occurrence_cap';

/**
 * `AI_SWEEP_SEVERITIES` is declared most-severe-first, so its index IS the
 * descending rank. Deriving it here rather than hard-coding a second list
 * means a severity added to the shared union can never silently sort last.
 */
const SEVERITY_RANK: ReadonlyMap<AiSweepSeverity, number> = new Map(
  AI_SWEEP_SEVERITIES.map((severity, index) => [severity, index]),
);

function severityRank(severity: AiSweepSeverity): number {
  // An unknown severity sorts after every known one rather than throwing: a
  // sort comparator is the wrong place to fail a whole occurrence.
  return SEVERITY_RANK.get(severity) ?? AI_SWEEP_SEVERITIES.length;
}

/**
 * PURE. The documented order — (severity desc, kind asc, deviceId asc,
 * subjectKey asc) — never iteration order, never the model's array order.
 * Returns a new array; the input is not mutated.
 */
export function orderCohortCandidates(candidates: readonly CohortCandidate[]): CohortCandidate[] {
  return [...candidates].sort((a, b) => (
    severityRank(a.severity) - severityRank(b.severity)
    || a.kind.localeCompare(b.kind)
    || a.deviceId.localeCompare(b.deviceId)
    || a.subjectKey.localeCompare(b.subjectKey)
    // Final tie-break so the order is TOTAL even for two candidates
    // indistinguishable on all four documented keys — otherwise the result
    // would depend on the engine's sort stability, i.e. on input order.
    || a.findingIndex - b.findingIndex
  ));
}

export interface SelectCohortArgs {
  ordered: readonly CohortCandidate[];
  /** The distinct devices already inside the trailing 24 h exposure window. */
  existingExposedDevices: ReadonlySet<string>;
  /** `floor(contractDevices * maxFleetPercentPerDay / 100)` — no `max(1, ·)`. */
  allowance: number;
  /** `source = 'policy_intent'` rows for this (org, agent) in the window. */
  policyDecisionsToday: number;
  maxPolicyDecisionsPerDay: number;
  maxUnattendedDevicesPerSweep: number;
}

/**
 * PURE. Walks the ordered list accumulating DISTINCT devices and stops at the
 * first candidate that would breach any of the three caps. Returns the
 * admitted prefix; everything after it is minted as an ordinary card.
 *
 * The walk STOPS at the first breach rather than skipping the offender and
 * continuing: a skip-and-continue would make admission depend on which later
 * candidate happens to be cheaper, which is exactly the non-determinism the
 * documented order exists to remove.
 */
export function selectCohort(args: SelectCohortArgs): {
  admitted: CohortCandidate[];
  stoppedBy: CohortStopReason | null;
} {
  const {
    ordered, existingExposedDevices,
    allowance: rawAllowance,
    policyDecisionsToday: rawPolicyDecisionsToday,
    maxPolicyDecisionsPerDay: rawMaxPolicyDecisionsPerDay,
    maxUnattendedDevicesPerSweep: rawMaxUnattendedDevicesPerSweep,
  } = args;

  // Every cap check below is an `x > cap` comparison, and in JS ANY comparison
  // against NaN is false — so a single non-finite cap would make that cap
  // never fire and admit the whole candidate list unattended, silently. The
  // live callers are all Zod-bounded integers today, but this module is pure
  // and trusts its callers forever; a future caller (or a policy-snapshot
  // migration) must not be able to turn a bound into a no-op. Non-finite
  // reads as ZERO — fail closed, never open.
  const finiteCap = (value: number): number => (Number.isFinite(value) ? value : 0);
  const allowance = finiteCap(rawAllowance);
  const maxPolicyDecisionsPerDay = finiteCap(rawMaxPolicyDecisionsPerDay);
  const maxUnattendedDevicesPerSweep = finiteCap(rawMaxUnattendedDevicesPerSweep);
  // A non-finite "already spent today" count is likewise treated as fully
  // spent rather than as zero.
  const seedDayCount = Number.isFinite(rawPolicyDecisionsToday)
    ? rawPolicyDecisionsToday
    : maxPolicyDecisionsPerDay;

  const admitted: CohortCandidate[] = [];
  // The projected union, seeded with the window. A candidate on a device
  // already in here costs the fleet cap nothing.
  const projectedDevices = new Set(existingExposedDevices);
  // Devices THIS occurrence would newly touch — the per-occurrence cap counts
  // these, not the window's.
  const occurrenceDevices = new Set<string>();
  let dayCount = seedDayCount;

  for (const candidate of ordered) {
    const newDeviceForWindow = !projectedDevices.has(candidate.deviceId);
    const newDeviceForOccurrence = !occurrenceDevices.has(candidate.deviceId);

    if (newDeviceForWindow && projectedDevices.size + 1 > allowance) {
      return { admitted, stoppedBy: 'fleet_cap' };
    }
    if (newDeviceForOccurrence && occurrenceDevices.size + 1 > maxUnattendedDevicesPerSweep) {
      return { admitted, stoppedBy: 'occurrence_cap' };
    }
    // Every candidate is one ACTION, whether or not its device is new.
    if (dayCount + 1 > maxPolicyDecisionsPerDay) {
      return { admitted, stoppedBy: 'day_cap' };
    }

    projectedDevices.add(candidate.deviceId);
    occurrenceDevices.add(candidate.deviceId);
    dayCount += 1;
    admitted.push(candidate);
  }

  return { admitted, stoppedBy: null };
}
