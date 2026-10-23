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

/**
 * One device's CIS score from its latest result row. Prefers the stored numeric
 * `score`; when that is missing/non-finite it is derived from
 * `passedChecks / totalChecks` (rounded once). Returns null — "not assessed" —
 * when no check was evaluated (such a scan stores score 100, which is absence
 * of evidence, not a pass). Never returns NaN.
 */
export function cisDeviceScore(row: {
  score?: number | null;
  passedChecks?: number | null;
  totalChecks?: number | null;
}): number | null {
  const total = row.totalChecks;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  if (typeof row.score === 'number' && Number.isFinite(row.score)) return row.score;
  const passed = row.passedChecks;
  if (typeof passed !== 'number' || !Number.isFinite(passed)) return null;
  return Math.round((passed / total) * 100);
}
