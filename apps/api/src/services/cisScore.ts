/**
 * The single definition of "average CIS score" (#9606). Both the CIS Hardening
 * page summary and the posture report's hardening aggregate average the stored
 * per-device `cis_baseline_results.score` of each device's latest result and
 * round once at the end — never an average of already-rounded percentages.
 * Returns null when there is nothing to average so each caller picks its own
 * empty-state (the page shows 100, the report shows "not assessed").
 */
export function averageCisScore(scores: readonly number[]): number | null {
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
}
