import { describe, expect, it } from 'vitest';
import { recommendCapCents, renderEvalMarkdown, scoreRun, summarizeDepth } from './score';

const c = { id: 'w-svc-1', os: 'windows', family: 'service', alert: { title: 't', severity: 'high', message: 'm' }, catalog: [], expect: { anyOf: ['builtin_action'], builtinAction: 'restart_service', forbid: ['reboot'] } } as const;
const outcome = (items: unknown[], rejected: unknown[] = []) => ({ summary: 's', items, rejected, noSafeFix: items.length === 0 }) as never;
const run = (extra = {}) => ({ caseId: 'w-svc-1', depth: 'quick' as const, status: 'completed', errorCode: null, costCents: 3, turns: 3, outcome: outcome([{ kind: 'builtin_action', action: 'restart_service' }]), ...extra });

describe('research eval scoring', () => {
  it('scores validity as accepted / submitted and checks the expectation', () => {
    expect(scoreRun(c as never, run({ outcome: outcome([{ kind: 'builtin_action', action: 'restart_service' }], [{ index: 1, reason: 'script_not_visible' }]) })))
      .toMatchObject({ accepted: 1, rejected: 1, validity: 0.5, expectationHit: true, forbiddenHit: false, failed: false });
  });
  it('a forbidden action is flagged even when accepted', () => {
    expect(scoreRun(c as never, run({ outcome: outcome([{ kind: 'builtin_action', action: 'reboot' }]) })).forbiddenHit).toBe(true);
  });
  it('a built-in other than the named one misses the expectation', () => {
    expect(scoreRun(c as never, run({ outcome: outcome([{ kind: 'builtin_action', action: 'kill_process' }]) })).expectationHit).toBe(false);
  });
  it('a failed or denied run is a failure with no validity', () => {
    expect(scoreRun(c as never, run({ status: 'failed', outcome: null }))).toMatchObject({ failed: true, validity: null, expectationHit: false });
  });
  it('"none" expectation is met by an honest no-safe-fix', () => {
    expect(scoreRun({ ...c, expect: { anyOf: ['none'] } } as never, run({ outcome: outcome([]) })).expectationHit).toBe(true);
  });
  it('summaries report p50/p90/max and a cap recommendation', () => {
    const scores = [1, 2, 3, 4, 10].map((cost) => scoreRun(c as never, run({ costCents: cost })));
    expect(summarizeDepth(scores, 'quick')).toMatchObject({ runs: 5, costP50: 3, costP90: 10, costMax: 10, recommendedCapCents: 13 });
    expect(recommendCapCents(0)).toBe(1);
  });
  it('renders a table per depth with the current default', () => {
    const scores = [scoreRun(c as never, run())];
    const md = renderEvalMarkdown([summarizeDepth(scores, 'quick')], scores, { quick: 5, deep: 25 });
    expect(md).toContain('## quick');
    expect(md).toContain('| 5c |');
    expect(md).toContain('w-svc-1');
  });
});

describe('denied and errored runs', () => {
  it('are excluded from cost percentiles and the cap recommendation, and flagged loudly', () => {
    const ok = [4, 6].map((cost) => scoreRun(c as never, run({ costCents: cost })));
    const denied = scoreRun(c as never, run({ status: 'denied', outcome: null, costCents: 0, turns: 0 }));
    const errored = scoreRun(c as never, run({ status: 'harness_error', outcome: null, costCents: 0, turns: 0 }));
    const summary = summarizeDepth([...ok, denied, errored], 'quick');
    expect(summary).toMatchObject({ runs: 4, notExecuted: 2, failed: 2, costP50: 4, costP90: 6, recommendedCapCents: 8 });
    expect(renderEvalMarkdown([summary], [...ok, denied, errored], { quick: 5, deep: 25 })).toContain('WARNING');
  });
  it('a depth where nothing executed has no cap recommendation', () => {
    const denied = scoreRun(c as never, run({ status: 'denied', outcome: null, costCents: 0 }));
    const summary = summarizeDepth([denied], 'quick');
    expect(summary.recommendedCapCents).toBeNull();
    expect(renderEvalMarkdown([summary], [denied], { quick: 5, deep: 25 })).toContain('insufficient data');
  });
  it('a failed-but-executed run still counts toward cost', () => {
    const failedRun = scoreRun(c as never, run({ status: 'failed', outcome: null, costCents: 9 }));
    expect(summarizeDepth([failedRun], 'quick')).toMatchObject({ notExecuted: 0, failed: 1, costP90: 9 });
  });
});
