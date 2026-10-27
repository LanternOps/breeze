import { describe, expect, it } from 'vitest';
import { resolveParkedIntent } from './runLedger';

/**
 * W5 PR B (#5220, Decision 12): an approved Tier-3 built-in step is executed
 * by the release worker, which records its failure as `{ error,
 * flowStepError: { code, policy } }` on a failed intent. The wake keeps the
 * built-in's own step error code, and a policy failure (egress_blocked, a
 * per-run cap) ends the run whatever `onFailure` says — exactly as the same
 * step executed directly by the runner would.
 */
const NOW = new Date('2027-01-10T10:00:00.000Z');
const ctx = (over: Partial<Parameters<typeof resolveParkedIntent>[1]> = {}) => ({
  stepId: 'call', tool: 'http_request', toolSource: 'builtin', onFailure: 'continue' as const,
  cancelRequested: false, now: NOW, ...over,
});
const failed = (result: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  id: 'i1', status: 'failed', result, errorCode: 'tool_returned_error', executedAt: NOW, decidedByUserId: 'u1', ...over,
});

describe('resolveParkedIntent — released built-ins', () => {
  it('a policy failure ends the run with the built-in code even under onFailure continue', () => {
    const r = resolveParkedIntent(failed({ error: 'Blocked by the egress guard.', flowStepError: { code: 'egress_blocked', policy: true } }), ctx());
    expect(r).toMatchObject({
      kind: 'end',
      step: { status: 'failed', errorCode: 'egress_blocked' },
      run: { status: 'failed', errorCode: 'egress_blocked' },
      unknownOutcome: false,
    });
  });

  it('a non-policy failure keeps its code and honours onFailure continue', () => {
    const r = resolveParkedIntent(failed({ error: 'The server answered 503.', flowStepError: { code: 'http_status', policy: false } }), ctx());
    expect(r).toMatchObject({ kind: 'continue', status: 'failed', step: { status: 'failed', errorCode: 'http_status', error: 'The server answered 503.' } });
  });

  it('a non-policy failure under onFailure stop ends the run with its code', () => {
    const r = resolveParkedIntent(failed({ error: 'The server answered 503.', flowStepError: { code: 'http_status', policy: false } }), ctx({ onFailure: 'stop' }));
    expect(r).toMatchObject({ kind: 'end', run: { status: 'failed', errorCode: 'http_status' } });
  });

  it('an unknown code or a non-built-in step keeps the W04 generic step_failed', () => {
    expect(resolveParkedIntent(failed({ error: 'x', flowStepError: { code: 'not_a_code', policy: true } }), ctx()))
      .toMatchObject({ kind: 'continue', step: { errorCode: 'step_failed' } });
    expect(resolveParkedIntent(failed({ error: 'x', flowStepError: { code: 'egress_blocked', policy: true } }), ctx({ toolSource: 'core', tool: 'run_script' })))
      .toMatchObject({ kind: 'continue', step: { errorCode: 'step_failed' } });
  });

  it('a released built-in that may have run (execution_error after executedAt) is still unknown_outcome', () => {
    expect(resolveParkedIntent(failed(null, { errorCode: 'execution_error' }), ctx()))
      .toMatchObject({ kind: 'end', unknownOutcome: true, run: { errorCode: 'unknown_outcome' } });
  });
});
