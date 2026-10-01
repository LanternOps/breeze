import { calculateCostCents } from './aiCostTracker';

/**
 * #7667 — the Agent SDK's `result.total_cost_usd` is a RUNNING total, not a
 * per-turn figure. Within one streaming-input `query()` it accumulates turn
 * over turn, and the first result of a query started with `resume` also carries
 * every earlier query's cost from the transcript. `result.usage` and
 * `num_turns` ARE per turn. Billing the raw total charged turn n for turns 1…n.
 *
 * This turns the running total into the cost of the turn that just finished:
 *
 * - a later result on the same query → `total − baseline`, never below 0;
 * - the first result of a brand-new query → the whole total (nothing came
 *   before it, and it also covers SDK side calls `result.usage` omits);
 * - the first result of a RESUMED query → this turn's `result.usage` priced
 *   at the model's rate, because the total there includes earlier queries we
 *   cannot separate out without persisting the previous total.
 *
 * The baseline only ever moves up, so a total that dips is never billed twice
 * when it climbs back. Interrupted or aborted turns that the SDK under-reports
 * are not reconciled (W05 spike Q6).
 *
 * Catalog sessions do not use this: they price `result.usage` from the
 * revision snapshot and ignore the SDK's list-price total entirely.
 */
export interface SdkTurnCostInput {
  /** `result.total_cost_usd` as the SDK reported it (may be missing). */
  reportedTotalUsd: number | null | undefined;
  /** Highest running total seen on this query so far; undefined before its first result. */
  baselineUsd: number | undefined;
  /** True when this query was started with `resume` (it carries earlier queries' cost). */
  resumedQuery: boolean;
  /** Model id used to price `usage` for the first result of a resumed query. */
  model: string;
  /** This turn's own token usage (the SDK's per-turn `result.usage`). */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface SdkTurnCost {
  /** Cost of this turn alone, in USD. 0 when the SDK reported no total. */
  turnCostUsd: number;
  /** The baseline to store for the next result of the same query. */
  baselineUsd: number | undefined;
}

export function sdkTurnCostFromRunningTotal(input: SdkTurnCostInput): SdkTurnCost {
  const reported = input.reportedTotalUsd;
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
    // No usable total: bill 0 here and leave the baseline alone. The ledger
    // writer prices the turn's tokens itself when the cost is 0.
    return { turnCostUsd: 0, baselineUsd: input.baselineUsd };
  }

  if (input.baselineUsd !== undefined) {
    return {
      turnCostUsd: Math.max(0, reported - input.baselineUsd),
      baselineUsd: Math.max(input.baselineUsd, reported),
    };
  }

  if (!input.resumedQuery) {
    return { turnCostUsd: reported, baselineUsd: reported };
  }

  const { usage } = input;
  const cents = calculateCostCents(
    input.model,
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  );
  return { turnCostUsd: cents / 100, baselineUsd: reported };
}
