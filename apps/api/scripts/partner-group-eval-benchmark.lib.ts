/** Pure acceptance/report helpers; importing these never seeds or connects. */

/**
 * W2b acceptance criteria, fixed BEFORE the first run. Do not derive these
 * from measurements. All ceilings are inclusive; any missing measurement
 * (including --skip-churn) makes a run incomplete, never a passing release gate.
 * Run on production-class Postgres; a laptop result is not release evidence.
 */
export const PARTNER_GROUP_BENCHMARK_PASS_CRITERIA = Object.freeze({
  coldEvalSecondsMax: 60,
  coldFailedOrgsMax: 0,
  steadyStateSecondsMax: 30,
  steadyStateMembershipWritesMax: 0,
  perOrgFilterP95MsMax: 250,
  largeOrgFilterMsMax: 400,
  churnDrainSecondsMax: 900,
  churnJobP95MsMax: 200,
  churnFailedJobsMax: 0,
  churnDeadlocksMax: 0,
  sweepSecondsMax: 600,
  probeP95MsMax: 50,
});

export interface PartnerGroupBenchmarkResult {
  coldEvalSeconds: number;
  coldFailedOrgs: number;
  steadyStateSeconds: number;
  steadyStateMembershipWrites: number;
  perOrgFilterP95Ms: number;
  largeOrgFilterMs: number;
  churnDrainSeconds: number | null;
  churnJobP95Ms: number | null;
  churnFailedJobs: number | null;
  churnDeadlocks: number | null;
  sweepSeconds: number;
  probeP95Ms: number;
}

const CRITERIA: ReadonlyArray<readonly [keyof PartnerGroupBenchmarkResult, keyof typeof PARTNER_GROUP_BENCHMARK_PASS_CRITERIA]> = [
  ['coldEvalSeconds', 'coldEvalSecondsMax'],
  ['coldFailedOrgs', 'coldFailedOrgsMax'],
  ['steadyStateSeconds', 'steadyStateSecondsMax'],
  ['steadyStateMembershipWrites', 'steadyStateMembershipWritesMax'],
  ['perOrgFilterP95Ms', 'perOrgFilterP95MsMax'],
  ['largeOrgFilterMs', 'largeOrgFilterMsMax'],
  ['churnDrainSeconds', 'churnDrainSecondsMax'],
  ['churnJobP95Ms', 'churnJobP95MsMax'],
  ['churnFailedJobs', 'churnFailedJobsMax'],
  ['churnDeadlocks', 'churnDeadlocksMax'],
  ['sweepSeconds', 'sweepSecondsMax'],
  ['probeP95Ms', 'probeP95MsMax'],
];

function passes(value: number | null, ceiling: number): boolean {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= ceiling;
}

export function evaluateBenchmarkResult(result: PartnerGroupBenchmarkResult): { pass: boolean; failures: string[] } {
  const failures = CRITERIA.flatMap(([measure, criterion]) => {
    const ceiling = PARTNER_GROUP_BENCHMARK_PASS_CRITERIA[criterion];
    const actual = result[measure];
    return passes(actual, ceiling) ? [] : [`${measure}: ${actual === null ? 'not measured' : actual} (required ≤ ${ceiling})`];
  });
  return { pass: failures.length === 0, failures };
}

/** Nearest-rank percentile; an empty sample cannot masquerade as a fast query. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0 || values.some(value => !Number.isFinite(value)) || !Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error('percentile requires finite samples and a percentile between 0 and 100');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.max(1, Math.ceil(p / 100 * sorted.length)) - 1];
  if (value === undefined) throw new Error('percentile sample missing');
  return value;
}

export interface PartnerGroupBenchmarkOptions { keepData: boolean; cleanup: boolean; skipChurn: boolean }
export function parseBenchmarkArgs(argv: readonly string[]): PartnerGroupBenchmarkOptions {
  const options = { keepData: false, cleanup: false, skipChurn: false };
  for (const arg of argv) {
    switch (arg) {
      case '--': break;
      case '--keep-data': options.keepData = true; break;
      case '--cleanup': options.cleanup = true; break;
      case '--skip-churn': options.skipChurn = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.cleanup && (options.keepData || options.skipChurn)) {
    throw new Error('--cleanup cannot be combined with run options');
  }
  return options;
}

export function formatReport(result: PartnerGroupBenchmarkResult): string {
  return [
    '| measure | acceptance | measured | pass |',
    '| --- | --- | --- | --- |',
    ...CRITERIA.map(([measure, criterion]) => {
      const ceiling = PARTNER_GROUP_BENCHMARK_PASS_CRITERIA[criterion];
      const value = result[measure];
      return `| ${measure} | ≤ ${ceiling} | ${value === null ? 'not measured' : value} | ${passes(value, ceiling) ? 'PASS' : 'FAIL'} |`;
    }),
  ].join('\n');
}
