import { describe, expect, it } from 'vitest';
import {
  PARTNER_GROUP_BENCHMARK_PASS_CRITERIA,
  evaluateBenchmarkResult,
  formatReport,
  parseBenchmarkArgs,
  percentile,
  type PartnerGroupBenchmarkResult,
} from './partner-group-eval-benchmark.lib';

const boundary: PartnerGroupBenchmarkResult = {
  coldEvalSeconds: 60, coldFailedOrgs: 0, steadyStateSeconds: 30,
  steadyStateMembershipWrites: 0, perOrgFilterP95Ms: 250, largeOrgFilterMs: 400,
  churnDrainSeconds: 900, churnJobP95Ms: 200, churnFailedJobs: 0,
  churnDeadlocks: 0, sweepSeconds: 600, probeP95Ms: 50,
};
const criteria: Array<[keyof PartnerGroupBenchmarkResult, number]> = [
  ['coldEvalSeconds', 60], ['coldFailedOrgs', 0], ['steadyStateSeconds', 30],
  ['steadyStateMembershipWrites', 0], ['perOrgFilterP95Ms', 250], ['largeOrgFilterMs', 400],
  ['churnDrainSeconds', 900], ['churnJobP95Ms', 200], ['churnFailedJobs', 0],
  ['churnDeadlocks', 0], ['sweepSeconds', 600], ['probeP95Ms', 50],
];

describe('partner group benchmark acceptance, fixed before the first run', () => {
  it('pins every criterion independently of the measured result', () => {
    expect(PARTNER_GROUP_BENCHMARK_PASS_CRITERIA).toEqual({
      coldEvalSecondsMax: 60, coldFailedOrgsMax: 0, steadyStateSecondsMax: 30,
      steadyStateMembershipWritesMax: 0, perOrgFilterP95MsMax: 250, largeOrgFilterMsMax: 400,
      churnDrainSecondsMax: 900, churnJobP95MsMax: 200, churnFailedJobsMax: 0,
      churnDeadlocksMax: 0, sweepSecondsMax: 600, probeP95MsMax: 50,
    });
  });
  it.each(criteria)('%s passes at %s and fails immediately above it', (measure, max) => {
    expect(evaluateBenchmarkResult({ ...boundary, [measure]: max })).toEqual({ pass: true, failures: [] });
    const verdict = evaluateBenchmarkResult({ ...boundary, [measure]: max + 0.01 });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain(measure);
  });
  it.each([NaN, Infinity, -1, null])('fails closed for invalid or unmeasured values (%s)', value => {
    expect(evaluateBenchmarkResult({ ...boundary, churnDrainSeconds: value }).pass).toBe(false);
  });
  it('reports all failures, not just the first', () => {
    expect(evaluateBenchmarkResult({ ...boundary, coldFailedOrgs: 1, churnDeadlocks: 1 }).failures).toHaveLength(2);
  });
});

describe('percentile', () => {
  it('uses nearest rank without mutating samples', () => {
    const samples = [5, 1, 2, 4, 3];
    expect(percentile(samples, 50)).toBe(3);
    expect(percentile(samples, 95)).toBe(5);
    expect(samples).toEqual([5, 1, 2, 4, 3]);
  });
  it('refuses empty/invalid samples so missing observations cannot pass as zero', () => {
    expect(() => percentile([], 95)).toThrow();
    expect(() => percentile([NaN], 95)).toThrow();
    expect(() => percentile([1], 101)).toThrow();
  });
});

describe('arguments and reporting', () => {
  it('accepts only the three supported options and a pnpm separator', () => {
    expect(parseBenchmarkArgs([])).toEqual({ keepData: false, cleanup: false, skipChurn: false });
    expect(parseBenchmarkArgs(['--', '--keep-data', '--skip-churn'])).toEqual({ keepData: true, cleanup: false, skipChurn: true });
    expect(parseBenchmarkArgs(['--cleanup']).cleanup).toBe(true);
    expect(() => parseBenchmarkArgs(['--unknown'])).toThrow('unknown argument');
    expect(() => parseBenchmarkArgs(['--cleanup', '--keep-data'])).toThrow();
  });
  it('formats each acceptance and result in a markdown table', () => {
    const report = formatReport(boundary);
    expect(report).toContain('| measure | acceptance | measured | pass |');
    expect(report).toContain('| coldEvalSeconds | ≤ 60 | 60 | PASS |');
    expect(report.match(/\| PASS \|/g)).toHaveLength(12);
    expect(formatReport({ ...boundary, churnDrainSeconds: null })).toContain('| churnDrainSeconds | ≤ 900 | not measured | FAIL |');
  });
});
