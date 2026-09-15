/**
 * AI Scorecard W04 (#5761, refs #4182) — the arithmetic behind the measured
 * impact band, kept pure and separately tested.
 *
 * Cohort SQL can only be exercised against a live database, which is slow and
 * hides arithmetic mistakes inside seed-data noise. The statistic itself is
 * arithmetic, so it lives here with hand-computed expectations in
 * `impactStatistics.test.ts`.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **Still-open items are censored, never dropped.** Conditioning on completion
 *    biases the two arms differently — the AI arm generally holds the easier
 *    items, which complete sooner, so dropping the open ones flatters it twice.
 * 2. **Below `MEASURED_MIN_COHORT_N` there is no number.** `buildArm` returns
 *    `null` rather than a small-sample figure the UI would have to caveat.
 */

import { MEASURED_MIN_COHORT_N, type MeasuredArm } from '@breeze/shared';

/**
 * One observed item.
 *
 * @property minutes  Minutes from the cohort-entry instant (`triggered_at + L`,
 *                    `created_at + L`) to the outcome, or to the censoring
 *                    instant when the outcome never happened inside the window.
 * @property observed `false` ⇒ right-censored at `minutes`: we know the item had
 *                    not reached the outcome by then, and nothing more.
 */
export interface Observation {
  minutes: number;
  observed: boolean;
}

/**
 * PRIMARY statistic: the share of the arm that reached the outcome within
 * `horizonMinutes`.
 *
 * A censored item stays in the denominator and can never be a success — it is
 * exactly the "we don't know yet" case, and counting it either way would be a
 * claim the data does not support. Returns 0 (not NaN) for an empty arm.
 */
export function proportionWithinHorizon(obs: readonly Observation[], horizonMinutes: number): number {
  if (obs.length === 0) return 0;
  const within = obs.filter((o) => o.observed && o.minutes <= horizonMinutes).length;
  return within / obs.length;
}

/**
 * Kaplan–Meier product-limit estimator, evaluated at quantile `q`.
 *
 * At each distinct event time `t` with `d` events among `n` still at risk,
 * `S *= (1 - d/n)`. The quantile is the smallest `t` where `S(t) <= 1 - q`.
 * Returns `null` when survival never gets there — a cohort too censored to
 * support the quantile gets no number rather than an extrapolated one.
 */
export function kaplanMeierQuantile(obs: readonly Observation[], q: number): number | null {
  if (obs.length === 0) return null;

  const sorted = [...obs].sort((a, b) => a.minutes - b.minutes || Number(b.observed) - Number(a.observed));
  const target = 1 - q;
  let survival = 1;
  let atRisk = sorted.length;
  let index = 0;

  while (index < sorted.length) {
    const time = sorted[index]!.minutes;
    let events = 0;
    let leaving = 0;
    while (index < sorted.length && sorted[index]!.minutes === time) {
      if (sorted[index]!.observed) events += 1;
      leaving += 1;
      index += 1;
    }
    if (events > 0) {
      survival *= 1 - events / atRisk;
      // Floating-point slack: a survival that lands a hair above the target after
      // a long product should still count as reaching it.
      if (survival <= target + 1e-9) return time;
    }
    atRisk -= leaving;
  }

  return null;
}

/**
 * Assemble one arm, or `null` when it is below the display gate.
 *
 * The gate is a display rule, not a substitute for correct cohort formation: at
 * n = 20 the upper decile holds about two observations, so a p90 is reported
 * with its cohort size or not at all.
 */
export function buildArm(obs: readonly Observation[], horizonMinutes: number): MeasuredArm | null {
  if (obs.length < MEASURED_MIN_COHORT_N) return null;
  return {
    n: obs.length,
    proportionWithinHorizon: proportionWithinHorizon(obs, horizonMinutes),
    censoredP50Minutes: kaplanMeierQuantile(obs, 0.5),
    censoredP90Minutes: kaplanMeierQuantile(obs, 0.9),
  };
}

/**
 * Median of a plain numeric sample (recorded technician minutes), or `null` when
 * the sample is empty. Deliberately not censored: a recorded-minutes total is
 * either present for a ticket or the ticket is excluded as unlogged.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
