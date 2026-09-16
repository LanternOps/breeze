/**
 * #4442 W05 — the status/decidedVia → outcome mapping the sweep run detail
 * reports. Split into its own file because the mapping is the whole point of
 * the W05 run-detail change and every `buildRunTrace` call site in
 * `runTrace.test.ts` passes an EMPTY intents array, so the function was never
 * actually invoked there.
 *
 * The distinction that matters is `auto_executing`: an intent approved by
 * POLICY is running unattended on a customer machine, which reads very
 * differently from one a human approved and must never collapse into the same
 * "waiting for approval" cell.
 */
import { describe, expect, it } from 'vitest';
import type { ActionIntentStatus } from '../../db/schema/actionIntents';
import { sweepProposalOutcome } from './runTrace';

const cases: Array<[ActionIntentStatus, string | null, string]> = [
  ['pending_approval', null, 'pending'],
  ['pending_approval', 'policy', 'pending'],
  // The act-mode case: policy-decided and live.
  ['approved', 'policy', 'auto_executing'],
  ['executing', 'policy', 'auto_executing'],
  // A HUMAN approved it — not unattended autonomy, so not `auto_executing`.
  ['approved', 'human', 'pending'],
  ['approved', null, 'pending'],
  ['executing', 'human', 'pending'],
  ['completed', 'policy', 'executed'],
  ['completed', 'human', 'executed'],
  ['failed', 'policy', 'failed'],
  ['rejected', 'human', 'declined'],
  ['cancelled', null, 'declined'],
  ['expired', null, 'expired'],
];

describe('sweepProposalOutcome (#4442 W05)', () => {
  it.each(cases)('maps status=%s decidedVia=%s to %s', (status, decidedVia, expected) => {
    expect(sweepProposalOutcome({ status, decidedVia })).toBe(expected);
  });

  it('only ever reports auto_executing for a POLICY decision', () => {
    const autoExecuting = cases.filter(([, , outcome]) => outcome === 'auto_executing');
    expect(autoExecuting.length).toBeGreaterThan(0);
    for (const [, decidedVia] of autoExecuting) expect(decidedVia).toBe('policy');
  });

  it('falls back to pending for an unrecognised status rather than inventing an outcome', () => {
    expect(sweepProposalOutcome({
      status: 'something_new' as ActionIntentStatus,
      decidedVia: 'policy',
    })).toBe('pending');
  });
});
