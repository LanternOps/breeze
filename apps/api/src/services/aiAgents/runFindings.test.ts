import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS } from '@breeze/shared';
import { aiAgentRuns } from '../../db/schema';
import {
  FINDINGS_TO_REVIEW_OUTCOME_PATHS,
  countFindingsToReview,
  findingsToReviewSql,
  summaryExcerpt,
} from './runFindings';
import { buildRunTrace, type RunTraceRunInput } from './runTrace';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

const dialect = new PgDialect();

/**
 * The fixture the parity test runs through BOTH derivations: two sweep
 * findings, one proposed action, one denied action, one executed action.
 * Expected count is 3 — denied and executed are not findings to review.
 */
const MIXED_OUTCOME: Record<string, unknown> = {
  runVerdict: 'no_action',
  sweepFindings: {
    summary: 'Two hosts are missing disk headroom.',
    findings: [
      {
        kind: 'disk_pressure', severity: 'warning', deviceId: null,
        title: 'Low disk', detail: 'C: is at 94%', evidence: { freePercent: 6 },
      },
      {
        kind: 'disk_pressure', severity: 'critical', deviceId: null,
        title: 'Low disk', detail: 'C: is at 98%', evidence: { freePercent: 2 },
      },
    ],
  },
  proposedActions: [{ tool: 'manage_devices', action: 'restart', args: { secret: 'nope' } }],
  deniedActions: [{ tool: 'run_script', reason: 'not in allowlist' }],
  executedActions: [{ tool: 'get_device', result: 'ok', durationMs: 12 }],
};

function baseRun(overrides: Partial<RunTraceRunInput> = {}): RunTraceRunInput {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: null,
    alertId: null,
    anomalyIncidentId: null,
    triggerKind: 'schedule',
    modeAtStart: 'shadow',
    status: 'completed',
    summary: null,
    scheduleId: null,
    triggerRef: {},
    reportRunId: null,
    outcome: {},
    intentIds: [],
    turnCount: 2,
    costCents: 4,
    errorCode: null,
    queuedAt: new Date('2026-09-02T10:00:00.000Z'),
    startedAt: new Date('2026-09-02T10:00:01.000Z'),
    finishedAt: new Date('2026-09-02T10:00:30.000Z'),
    ...overrides,
  };
}

/**
 * Exactly what `RunDetailPage.tsx` computes from the DETAIL DTO today (search
 * `findingsToReview` there). The parity test below asserts the server-side
 * helper agrees with it — if the two ever diverge, the run list and the run
 * detail page would badge the same run with different numbers, which is the
 * whole reason this helper exists.
 */
function webRuleOverDetailDto(detail: ReturnType<typeof buildRunTrace>): number {
  return (detail.sweep?.findings.length ?? 0)
    + detail.trace.filter((entry) => entry.kind === 'proposed').length;
}

describe('countFindingsToReview', () => {
  it('counts sweep findings plus proposed trace entries and excludes denied ones', () => {
    expect(countFindingsToReview(MIXED_OUTCOME)).toBe(3);
  });

  it('is unchanged when denied actions are added', () => {
    const withMoreDenials = {
      ...MIXED_OUTCOME,
      deniedActions: [
        { tool: 'run_script', reason: 'not in allowlist' },
        { tool: 'manage_users', reason: 'read-only profile' },
        { tool: 'delete_device', reason: 'read-only profile' },
      ],
    };
    expect(countFindingsToReview(withMoreDenials)).toBe(countFindingsToReview(MIXED_OUTCOME));
  });

  it('is unchanged when executed actions are added', () => {
    const withMoreExecuted = {
      ...MIXED_OUTCOME,
      executedActions: [
        { tool: 'get_device', result: 'ok', durationMs: 12 },
        { tool: 'list_alerts', result: 'ok', durationMs: 30 },
      ],
    };
    expect(countFindingsToReview(withMoreExecuted)).toBe(countFindingsToReview(MIXED_OUTCOME));
  });

  it('returns 0 for an empty outcome', () => {
    expect(countFindingsToReview({})).toBe(0);
  });

  it('returns 0 for a null/undefined outcome rather than throwing', () => {
    expect(countFindingsToReview(null)).toBe(0);
    expect(countFindingsToReview(undefined)).toBe(0);
  });

  // `outcome` is a jsonb column with no compile-time shape; a maximally
  // corrupt row must project a number, never throw inside a read route.
  it('tolerates a corrupt outcome whose counted keys are the wrong type', () => {
    expect(countFindingsToReview({
      sweepFindings: { findings: 'not-an-array' },
      proposedActions: { nope: true },
    })).toBe(0);
    expect(countFindingsToReview({ sweepFindings: 7, proposedActions: null })).toBe(0);
  });

  // Mirrors `projectSweep`, which returns null (hence 0 findings) when the
  // outcome carries no `sweepFindings` object at all.
  it('counts only proposed entries for a non-sweep run', () => {
    expect(countFindingsToReview({
      proposedActions: [{ tool: 'a' }, { tool: 'b' }],
      deniedActions: [{ tool: 'c', reason: 'x' }],
    })).toBe(2);
  });
});

describe('findingsToReviewSql — the list/agent-list derivation', () => {
  const compiled = () => dialect.sqlToQuery(findingsToReviewSql(aiAgentRuns.outcome)).sql;

  it('emits one array-length term per counted outcome path', () => {
    const sql = compiled();
    expect(sql.match(/jsonb_array_length/g)).toHaveLength(FINDINGS_TO_REVIEW_OUTCOME_PATHS.length);
    expect(sql.match(/jsonb_typeof/g)).toHaveLength(FINDINGS_TO_REVIEW_OUTCOME_PATHS.length);
  });

  it('names exactly the counted json keys', () => {
    const sql = compiled();
    expect(sql).toContain("->'sweepFindings'->'findings'");
    expect(sql).toContain("->'proposedActions'");
  });

  // The SQL is the LIST side of the same rule `countFindingsToReview` applies
  // on the detail side. A denied/executed term appearing here would inflate
  // the list badge relative to the detail page.
  it('never counts denied or executed actions', () => {
    const sql = compiled();
    expect(sql).not.toContain('deniedActions');
    expect(sql).not.toContain('executedActions');
  });

  it('binds no parameters — the counted keys are module constants, never caller input', () => {
    expect(dialect.sqlToQuery(findingsToReviewSql(aiAgentRuns.outcome)).params).toEqual([]);
  });
});

describe('findingsToReview parity — list rule vs detail DTO', () => {
  it('agrees with what the run-detail page derives from the detail DTO', () => {
    const detail = buildRunTrace(
      baseRun({ outcome: MIXED_OUTCOME }),
      { name: 'Sweeper', kind: 'triage' },
      null,
      [],
      [],
    );

    // Control: the fixture really does exercise all three trace kinds plus
    // sweep findings, so an agreement below is not vacuous.
    expect(detail.sweep?.findings).toHaveLength(2);
    expect(detail.trace.filter((e) => e.kind === 'proposed')).toHaveLength(1);
    expect(detail.trace.filter((e) => e.kind === 'denied')).toHaveLength(1);

    expect(webRuleOverDetailDto(detail)).toBe(3);
    expect(countFindingsToReview(MIXED_OUTCOME)).toBe(webRuleOverDetailDto(detail));
    expect(detail.findingsToReview).toBe(webRuleOverDetailDto(detail));
  });

  it('agrees on a run with no findings at all', () => {
    const detail = buildRunTrace(baseRun(), { name: 'Sweeper', kind: 'triage' }, null, [], []);
    expect(detail.findingsToReview).toBe(0);
    expect(countFindingsToReview({})).toBe(webRuleOverDetailDto(detail));
  });
});

describe('summaryExcerpt', () => {
  it('never leaves a lone surrogate before the ellipsis when the cut lands inside an emoji', () => {
    const head = 'a'.repeat(158);
    const out = summaryExcerpt(`${head}🎉 and then a long tail that will be cut off`);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(160);
    expect(out!.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(out!)).toBe(false);
  });

  it('returns null for a null or undefined summary', () => {
    expect(summaryExcerpt(null)).toBeNull();
    expect(summaryExcerpt(undefined)).toBeNull();
  });

  it('returns null for a whitespace-only summary', () => {
    expect(summaryExcerpt('   \n\t  ')).toBeNull();
  });

  it('takes the first sentence only, keeping its terminator', () => {
    expect(summaryExcerpt('Restarted the print spooler. It came back healthy.'))
      .toBe('Restarted the print spooler.');
    expect(summaryExcerpt('Did the disk fill up? Yes, twice.')).toBe('Did the disk fill up?');
  });

  it('returns the whole (normalized) text when there is no sentence terminator', () => {
    expect(summaryExcerpt('no terminator here')).toBe('no terminator here');
  });

  it('strips markdown emphasis', () => {
    expect(summaryExcerpt('**x**')).toBe('x');
    expect(summaryExcerpt('Restarted **spooler** and _verified_ it.'))
      .toBe('Restarted spooler and verified it.');
    expect(summaryExcerpt('Ran `Restart-Service` on the host.')).toBe('Ran Restart-Service on the host.');
    expect(summaryExcerpt('~~Ignored~~ the alert.')).toBe('Ignored the alert.');
    expect(summaryExcerpt('__Bold__ opener.')).toBe('Bold opener.');
  });

  it('does not eat an underscore inside a word', () => {
    expect(summaryExcerpt('The disk_free_percent metric dropped.'))
      .toBe('The disk_free_percent metric dropped.');
  });

  it('strips leading block markers and collapses whitespace', () => {
    expect(summaryExcerpt('## Summary\nDisk is full.')).toBe('Summary Disk is full.');
    expect(summaryExcerpt('- Disk is full.')).toBe('Disk is full.');
    expect(summaryExcerpt('> Disk is full.')).toBe('Disk is full.');
  });

  it('keeps link text and drops the url', () => {
    expect(summaryExcerpt('See [the report](https://example.com/r/1) for detail.'))
      .toBe('See the report for detail.');
  });

  it('does not break a sentence on a common abbreviation', () => {
    expect(summaryExcerpt('Several hosts, e.g. WKS-042, are low on disk. Next sentence.'))
      .toBe('Several hosts, e.g. WKS-042, are low on disk.');
  });

  it('truncates to the cap with an ellipsis', () => {
    const long = `${'word '.repeat(60)}end.`;
    const excerpt = summaryExcerpt(long);
    expect(excerpt).not.toBeNull();
    expect((excerpt as string).length).toBeLessThanOrEqual(AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS);
    expect(excerpt as string).toMatch(/…$/);
    // Truncation must not leave a dangling half-word.
    expect(excerpt as string).not.toMatch(/wor…$/);
  });

  it('does not add an ellipsis when the first sentence already fits', () => {
    expect(summaryExcerpt('Short and sweet.')).toBe('Short and sweet.');
  });

  it('truncates a single unbroken token rather than returning it whole', () => {
    const excerpt = summaryExcerpt('x'.repeat(400));
    expect((excerpt as string).length).toBe(AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS);
    expect(excerpt as string).toMatch(/…$/);
  });
});
