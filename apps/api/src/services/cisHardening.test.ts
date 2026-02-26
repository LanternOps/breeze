import { describe, expect, it } from 'vitest';
import {
  extractFailedCheckIds,
  normalizeCisFindings,
  normalizeCisSchedule,
  parseCisCollectorOutput,
  summarizeCisFindings,
} from './cisHardening';

describe('normalizeCisSchedule', () => {
  it('returns sane defaults when input is empty', () => {
    const schedule = normalizeCisSchedule(undefined);
    expect(schedule.enabled).toBe(true);
    expect(schedule.intervalHours).toBe(24);
    expect(typeof schedule.nextScanAt).toBe('string');
  });

  it('normalizes interval and preserves explicit nextScanAt', () => {
    const schedule = normalizeCisSchedule({
      enabled: true,
      intervalHours: 500,
      nextScanAt: '2026-02-26T10:00:00.000Z',
    });
    expect(schedule.intervalHours).toBe(168);
    expect(schedule.nextScanAt).toBe('2026-02-26T10:00:00.000Z');
  });
});

describe('CIS finding parsing', () => {
  it('normalizes collector findings from mixed key names', () => {
    const findings = normalizeCisFindings([
      { id: '1.1.1', result: 'PASS', severity: 'high', title: 'Password history' },
      { checkId: '9.1', status: 'fail', severity: 'critical', title: 'Firewall enabled' },
      { ruleId: 'invalid-no-status' },
    ]);

    expect(findings).toHaveLength(3);
    expect(findings[0]?.status).toBe('pass');
    expect(findings[1]?.severity).toBe('critical');
    expect(findings[2]?.status).toBe('error');
  });

  it('computes score from normalized findings', () => {
    const summary = summarizeCisFindings([
      { checkId: 'a', title: 'A', severity: 'high', status: 'pass' },
      { checkId: 'b', title: 'B', severity: 'critical', status: 'fail' },
      { checkId: 'c', title: 'C', severity: 'medium', status: 'not_applicable' },
    ]);

    expect(summary.totalChecks).toBe(2);
    expect(summary.passedChecks).toBe(1);
    expect(summary.failedChecks).toBe(1);
    expect(summary.score).toBe(50);
    expect(summary.bySeverity.critical).toBe(1);
  });
});

describe('parseCisCollectorOutput', () => {
  it('parses JSON collector output and prefers explicit totals', () => {
    const parsed = parseCisCollectorOutput(JSON.stringify({
      checkedAt: '2026-02-26T12:00:00.000Z',
      findings: [
        { checkId: '1', title: 'one', status: 'pass', severity: 'low' },
        { checkId: '2', title: 'two', status: 'fail', severity: 'high' },
      ],
      totalChecks: 99,
      passedChecks: 88,
      failedChecks: 11,
      score: 89,
      summary: { source: 'collector' },
    }));

    expect(parsed.checkedAt.toISOString()).toBe('2026-02-26T12:00:00.000Z');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.totalChecks).toBe(99);
    expect(parsed.passedChecks).toBe(88);
    expect(parsed.failedChecks).toBe(11);
    expect(parsed.score).toBe(89);
    expect(parsed.rawSummary.source).toBe('collector');
  });

  it('keeps explicit zero totals instead of falling back to derived values', () => {
    const parsed = parseCisCollectorOutput(JSON.stringify({
      findings: [
        { checkId: '1', title: 'one', status: 'pass', severity: 'low' },
        { checkId: '2', title: 'two', status: 'fail', severity: 'high' },
      ],
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      score: 0,
    }));

    expect(parsed.totalChecks).toBe(0);
    expect(parsed.passedChecks).toBe(0);
    expect(parsed.failedChecks).toBe(0);
    expect(parsed.score).toBe(0);
  });

  it('returns a failed parsing finding when collector output is malformed', () => {
    const parsed = parseCisCollectorOutput('{not-json');

    expect(parsed.totalChecks).toBe(1);
    expect(parsed.failedChecks).toBe(1);
    expect(parsed.passedChecks).toBe(0);
    expect(parsed.score).toBe(0);
    expect(parsed.findings[0]?.checkId).toBe('collector.parse');
    expect(parsed.findings[0]?.status).toBe('fail');
  });

  it('returns a failed parsing finding when collector output JSON root is not an object', () => {
    const parsed = parseCisCollectorOutput('["unexpected"]');

    expect(parsed.totalChecks).toBe(1);
    expect(parsed.failedChecks).toBe(1);
    expect(parsed.score).toBe(0);
    expect(parsed.findings[0]?.checkId).toBe('collector.parse');
  });
});

describe('extractFailedCheckIds', () => {
  it('returns only failed check IDs', () => {
    const ids = extractFailedCheckIds([
      { checkId: '1.1', status: 'fail', severity: 'high', title: 'A' },
      { checkId: '1.2', status: 'pass', severity: 'low', title: 'B' },
      { checkId: '1.3', status: 'fail', severity: 'critical', title: 'C' },
    ]);

    expect(ids.has('1.1')).toBe(true);
    expect(ids.has('1.2')).toBe(false);
    expect(ids.has('1.3')).toBe(true);
    expect(ids.size).toBe(2);
  });
});
