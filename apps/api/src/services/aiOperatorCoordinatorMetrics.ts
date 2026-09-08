/**
 * AI Operator coordinator metrics (#5205 W06), spec §11.2.
 *
 * A leaf module for the same reason `aiOperatorOutboxMetrics.ts` is one: it
 * imports `metricsRegistry` (a 37-line singleton holder) and nothing else, so
 * the worker role can serve `/metrics` without pulling the route/db/service
 * graph in behind it — an invariant `workerEntrypointClosure.contract.test.ts`
 * enforces mechanically.
 *
 * NAMING: the eight §11.2 metric names are used verbatim, WITHOUT the
 * `breeze_` prefix the product series otherwise uses. That is a deliberate,
 * recorded exception (baseline §10.2 flagged the inconsistency): the two
 * outbox gauges already shipped in W05 under the unprefixed names, so
 * prefixing only the six added here would leave the `ai_operator_*` family
 * half-and-half, which baseline §10.2 explicitly says not to do. Renaming the
 * whole family is a follow-up that must move both files at once.
 */

import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

/**
 * Point-in-time census of live tasks by state. A Gauge with a `state` label,
 * not a Counter: the question it answers is "how many tasks are stuck in
 * `waiting` right now", not "how many have ever been".
 *
 * Only LIVE states are published. Terminal states would grow without bound
 * and are answered by the task list, not by a scrape.
 */
const tasksByStateGauge = new Gauge({
  name: 'ai_operator_tasks_by_state',
  help: 'Live AI Operator tasks by state, sampled at the last coordinator tick',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

/**
 * Age of the OLDEST waiting task, in seconds. A max rather than a Histogram
 * because the operational question is "is anything stuck" — a distribution
 * hides one 72-hour outlier behind ten thousand healthy 30-second waits
 * (baseline §10.2).
 */
const waitingAgeSecondsMaxGauge = new Gauge({
  name: 'ai_operator_waiting_age_seconds_max',
  help: 'Age in seconds of the oldest waiting AI Operator task at the last coordinator tick',
  registers: [metricsRegistry],
});

/**
 * Lease reclaims. Every increment is a coordinator taking over a task whose
 * previous holder died or stalled — healthy in ones, a restart loop in
 * hundreds.
 */
const leaseReclaimsCounter = new Counter({
  name: 'ai_operator_lease_reclaims_total',
  help: 'AI Operator task leases reclaimed from an expired or abandoned holder',
  registers: [metricsRegistry],
});

/**
 * Handoffs taken because an effect could not be proven absent (spec §6.3's
 * "an operation whose effect cannot be proven absent hands off with
 * `unknown_effect`"). This is the metric that says the system is refusing to
 * guess, and it should be rare enough to alert on.
 */
const unknownEffectHandoffsCounter = new Counter({
  name: 'ai_operator_unknown_effect_handoffs_total',
  help: 'AI Operator tasks handed off because an effect could not be proven absent',
  registers: [metricsRegistry],
});

/**
 * Dispatch claims REFUSED. Labelled by the refusal reason from
 * `dispatchClaim.ts`'s `DispatchClaimRefusal`, because those four reasons
 * mean very different things: `operation_already_claimed` is an ordinary
 * healthy race, `operation_missing` is a broken invariant worth paging on.
 */
const dispatchClaimConflictsCounter = new Counter({
  name: 'ai_operator_dispatch_claim_conflicts_total',
  help: 'AI Operator dispatch claims refused, by refusal reason',
  labelNames: ['refusal'] as const,
  registers: [metricsRegistry],
});

/**
 * Rows examined per reconciler pass, by scan set. A Histogram (per-pass
 * distribution) with the `_rows` suffix — baseline §10.2 is explicit that a
 * `_total` name would have to be a Counter, and that leaving the name and the
 * type disagreeing is the one thing not to do.
 *
 * Buckets are sized around the 50-row per-set cap: a pass that repeatedly
 * saturates at 50 means the reconciler is behind, which is the signal.
 */
const reconcilerScanRowsHistogram = new Histogram({
  name: 'ai_operator_reconciler_scan_rows',
  help: 'Rows claimed per AI Operator reconciler scan pass, by scan set',
  labelNames: ['scan'] as const,
  buckets: [0, 1, 5, 10, 25, 50],
  registers: [metricsRegistry],
});

/** Reconciler scan-set names, used as the `scan` label. */
export type ReconcilerScanSet =
  | 'queued_past_wake'
  | 'waiting_past_wake'
  | 'running_past_lease'
  | 'terminal_unsettled_operation';

/**
 * Publish the live-state census from one coordinator tick.
 *
 * Callers pass a COMPLETE map of live states (missing entries are zeroed
 * explicitly rather than left at their previous value) — a gauge that stops
 * being set keeps reporting its last value forever, which would render a
 * drained `waiting` backlog as a permanent alert.
 */
export function recordAiOperatorTaskStates(counts: Record<string, number>): void {
  for (const state of ['queued', 'running', 'waiting', 'paused', 'stopping']) {
    tasksByStateGauge.set({ state }, counts[state] ?? 0);
  }
}

export function recordAiOperatorWaitingAgeMax(seconds: number): void {
  waitingAgeSecondsMaxGauge.set(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
}

export function recordAiOperatorLeaseReclaim(count = 1): void {
  if (count > 0) leaseReclaimsCounter.inc(count);
}

export function recordAiOperatorUnknownEffectHandoff(count = 1): void {
  if (count > 0) unknownEffectHandoffsCounter.inc(count);
}

export function recordAiOperatorDispatchClaimConflict(refusal: string): void {
  dispatchClaimConflictsCounter.inc({ refusal }, 1);
}

export function recordAiOperatorReconcilerScan(scan: ReconcilerScanSet, rows: number): void {
  reconcilerScanRowsHistogram.observe({ scan }, rows);
}
