import { describe, expect, it } from 'vitest';
import { aiUsageColumns, failedUnitOutput } from './runSlice';

/**
 * W5 PR B (#5220, Decision 13): an `ai` step's usage lands on its step row.
 * `flow_run_steps_ai_usage_chk` wants all three columns set (≥ 0) or none.
 */
describe('aiUsageColumns', () => {
  it('writes all three, whole and non-negative, for any outcome carrying aiUsage', () => {
    expect(aiUsageColumns({ kind: 'completed', output: {}, truncated: false, aiUsage: { inputTokens: 120.4, outputTokens: 20, costCents: 3.6 } }))
      .toEqual({ aiInputTokens: 120, aiOutputTokens: 20, aiCostCents: 4 });
    expect(aiUsageColumns({ kind: 'failed', code: 'ai_output_invalid', message: 'x', policy: false, aiUsage: { inputTokens: -1, outputTokens: 0, costCents: 0 } }))
      .toEqual({ aiInputTokens: 0, aiOutputTokens: 0, aiCostCents: 0 });
  });

  it('writes nothing for an outcome without usage, and for a skipped step', () => {
    expect(aiUsageColumns({ kind: 'completed', output: {}, truncated: false })).toEqual({});
    expect(aiUsageColumns({ kind: 'skipped' })).toEqual({});
  });
});

/**
 * W6 (#5221): a failed fleet step keeps its device sets as output, so a later
 * step under onFailure 'continue' chains on them (steps.<id>.output).
 */
describe('failedUnitOutput', () => {
  it('a failed row carries its recorded output into the scope; other failed rows carry null', () => {
    const sets = { dispatchedDeviceIds: ['d1'], succeededDeviceIds: [], failedDeviceIds: ['d1'] };
    expect(failedUnitOutput({ output: sets })).toEqual(sets);
    expect(failedUnitOutput({ output: null })).toBeNull();
    expect(failedUnitOutput({ output: undefined })).toBeNull();
  });
});
