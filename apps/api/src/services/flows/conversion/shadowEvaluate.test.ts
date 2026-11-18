import { describe, expect, it } from 'vitest';
import type { FlowDocumentV1 } from '@breeze/shared';
import { evaluateShadow, wouldParkSteps } from './shadowEvaluate';

/**
 * Tool Catalog W06 (#5221) Task A8 — what a shadow observation of a legacy
 * occurrence says about the converted document: the trigger in both
 * directions, the over-cap and target-set comparisons, and the steps that
 * would park for approval under the honour rule. Precedence:
 * trigger_mismatch > over_cap > target_set_mismatch > would_park.
 */
const doc = (steps: FlowDocumentV1['steps']): FlowDocumentV1 => ({ version: 1, name: 'f', trigger: { type: 'manual' }, inputs: [], steps });
const fleet = (id: string, over: Partial<FlowDocumentV1['steps'][number]> = {}) =>
  ({ id, tool: 'run_script_on_targets', input: {}, approval: 'default', onFailure: 'continue', timeoutSec: 300, ...over }) as FlowDocumentV1['steps'][number];
const D = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('evaluateShadow', () => {
  const base = { document: doc([fleet('a0')]), legacyMatched: true, flowMatched: true, legacyTargetIds: [D(1), D(2)], flowTargetIds: [D(2), D(1)], wouldParkStepIds: [] };

  it('agreement is not divergent; set order is ignored', () => {
    expect(evaluateShadow(base)).toEqual({ divergent: false, kind: null, detail: '' });
  });

  it('flow-only match is trigger_mismatch (and legacy-only too)', () => {
    expect(evaluateShadow({ ...base, legacyMatched: false })).toMatchObject({ divergent: true, kind: 'trigger_mismatch' });
    expect(evaluateShadow({ ...base, flowMatched: false })).toMatchObject({ divergent: true, kind: 'trigger_mismatch' });
  });

  it('a different device set is target_set_mismatch', () => {
    expect(evaluateShadow({ ...base, flowTargetIds: [D(1)] })).toMatchObject({ divergent: true, kind: 'target_set_mismatch' });
  });

  it('over the fleet cap is over_cap and outranks the set comparison', () => {
    const many = Array.from({ length: 501 }, (_, i) => D(i));
    expect(evaluateShadow({ ...base, flowTargetIds: many })).toMatchObject({ kind: 'over_cap' });
  });

  it('a parked step is would_park, the weakest divergence', () => {
    expect(evaluateShadow({ ...base, wouldParkStepIds: ['a0'] })).toMatchObject({ divergent: true, kind: 'would_park' });
    expect(evaluateShadow({ ...base, wouldParkStepIds: ['a0'], flowTargetIds: [D(9)] })).toMatchObject({ kind: 'target_set_mismatch' });
  });

  it('a trigger that matched on neither side is not divergent and compares nothing else', () => {
    expect(evaluateShadow({ ...base, legacyMatched: false, flowMatched: false, flowTargetIds: [] })).toEqual({ divergent: false, kind: null, detail: '' });
  });

  it('the detail carries counts, never device ids', () => {
    const r = evaluateShadow({ ...base, flowTargetIds: [D(1)] });
    expect(r.detail).not.toMatch(/[0-9a-f]{8}-/);
  });
});

describe('wouldParkSteps', () => {
  const d = doc([fleet('a0'), fleet('a1'), { id: 'n', tool: 'notify', input: {}, approval: 'default', onFailure: 'continue', timeoutSec: 300 } as never]);

  it('webhook script step would park, accepted or not', () => {
    expect(wouldParkSteps(d, { triggerKind: 'webhook', triggeredVia: 'webhook' }, ['a0', 'a1'])).toEqual(['a0', 'a1']);
  });

  it('schedule, event and UI runs honour accepted pre-approvals', () => {
    expect(wouldParkSteps(d, { triggerKind: 'schedule', triggeredVia: 'scheduler' }, ['a0'])).toEqual(['a1']);
    expect(wouldParkSteps(d, { triggerKind: 'event', triggeredVia: 'event' }, ['a0', 'a1'])).toEqual([]);
    expect(wouldParkSteps(d, { triggerKind: 'manual', triggeredVia: 'ui' }, ['a1'])).toEqual(['a0']);
    expect(wouldParkSteps(d, { triggerKind: 'manual', triggeredVia: 'api' }, ['a0', 'a1'])).toEqual(['a0', 'a1']);
  });

  it('a for-each fleet step always parks', () => {
    const fe = doc([fleet('a0', { forEach: { items: 'x', as: 'item', maxItems: 10, concurrency: 1 } })]);
    expect(wouldParkSteps(fe, { triggerKind: 'schedule', triggeredVia: 'scheduler' }, ['a0'])).toEqual(['a0']);
  });
});
