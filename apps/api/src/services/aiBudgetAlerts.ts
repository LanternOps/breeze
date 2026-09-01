/**
 * #4388 — pre-cap AI budget alerts.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md §4
 */

export const MAX_ALERT_THRESHOLDS = 5;

/** Sorted, unique, integer rungs in 1..99. Throws RangeError on anything else. */
export function normalizeAlertThresholds(input: readonly number[]): number[] {
  const out = [...new Set(input)].sort((a, b) => a - b);
  for (const n of out) {
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      throw new RangeError(`alert threshold must be an integer between 1 and 99, got ${n}`);
    }
  }
  if (out.length > MAX_ALERT_THRESHOLDS) {
    throw new RangeError(`at most ${MAX_ALERT_THRESHOLDS} alert thresholds`);
  }
  return out;
}
