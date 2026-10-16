// packages/shared/src/canonicalize/effectSet.test.ts
/**
 * Behaviour of the effect-set digest (Recipe Library spec §6.4:
 * "`effect_set_digest` = SHA-256 over the canonical serialization of that
 * list (same canonicalizer as `action_intents.arguments`)").
 *
 * The properties that matter are not "it hashes": they are that REORDERING
 * the list changes the digest (order is the §6.3 safety contract — disable
 * last), that the seal covers each effect's argumentDigest (callers canonicalize first,
 * so a jsonb key-order round trip is absorbed upstream), and that the task id and plan
 * revision are inside the seal (otherwise the same effect list approved on one
 * task would validate on another).
 *
 * Frozen cross-implementation vectors live in `effectSet.vectors.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './index';
import { canonicalizeEffectSet, computeEffectSetDigest, type PlannedEffectForDigest } from './effectSet';

// Behaviour tests may derive an argumentDigest at test time; the FROZEN vectors
// (vectors.ts) never do.
const ad = (args: Record<string, unknown>): string => computeArgumentDigest(canonicalizeArguments(args));

const TASK = '00000000-0000-4000-8000-0000000000a1';

const suspend: PlannedEffectForDigest = {
  ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1',
  accountExternalId: '101234567890',
  argumentDigest: ad({ userEmail: 'dana@customer.example', reason: 'offboarding' }),
};
const removeGroup: PlannedEffectForDigest = {
  ordinal: 0, toolName: 'google_remove_from_group', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1',
  accountExternalId: '101234567890',
  argumentDigest: ad({ userEmail: 'dana@customer.example', groupEmail: 'sales@customer.example', reason: 'offboarding' }),
};

// Ordinals must be contiguous from 0, so position-dependent variants are derived.
const suspendLast: PlannedEffectForDigest = { ...suspend, ordinal: 1 };
const removeGroupLast: PlannedEffectForDigest = { ...removeGroup, ordinal: 1 };

describe('computeEffectSetDigest', () => {
  it('is a 64-character lowercase hex SHA-256', () => {
    expect(computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [removeGroup, suspendLast] }))
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it('CHANGES when the effect ORDER changes — ordering is the §6.3 safety contract', () => {
    const forward = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [removeGroup, suspendLast] });
    const reversed = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend, removeGroupLast] });
    expect(reversed).not.toBe(forward);
  });

  it('depends on argumentDigest: callers must canonicalize; different digests give different set digests', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const same = computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...suspend, argumentDigest: ad({ reason: 'offboarding', userEmail: 'dana@customer.example' }) }],
    });
    expect(same).toBe(a); // canonicalization absorbs key order upstream
    const other = computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...suspend, argumentDigest: ad({ reason: 'offboarding', userEmail: 'other@customer.example' }) }],
    });
    expect(other).not.toBe(a);
  });

  it('refuses a malformed argumentDigest', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(() => computeEffectSetDigest({
        taskId: TASK, planRevision: 1, effects: [{ ...suspend, argumentDigest: bad }],
      })).toThrow(/argumentDigest/);
    }
  });

  it('binds the TASK: the same list under another task digests differently', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: '00000000-0000-4000-8000-0000000000a2', planRevision: 1, effects: [suspend],
    });
    expect(b).not.toBe(a);
  });

  it('binds the PLAN REVISION: a superseded plan can never digest to the new one', () => {
    const r1 = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const r2 = computeEffectSetDigest({ taskId: TASK, planRevision: 2, effects: [suspend] });
    expect(r2).not.toBe(r1);
  });

  it('changes when a single argument VALUE changes', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...suspend, argumentDigest: ad({ userEmail: 'other@customer.example', reason: 'offboarding' }) }],
    });
    expect(b).not.toBe(a);
  });

  it('changes when accountExternalId changes, even with identical arguments', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: TASK, planRevision: 1, effects: [{ ...suspend, accountExternalId: '999' }],
    });
    expect(b).not.toBe(a);
  });

  it('emits a versioned envelope whose effects array is in the caller-given order', () => {
    const canonical = canonicalizeEffectSet({ taskId: TASK, planRevision: 1, effects: [removeGroup, suspendLast] });
    expect(canonical).toContain('"v":1');
    expect(canonical.indexOf('google_remove_from_group')).toBeLessThan(canonical.indexOf('google_suspend_user'));
  });

  it('refuses an empty effect set — an approval over nothing is not an approval', () => {
    expect(() => computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [] }))
      .toThrow(/at least one effect/);
  });

  it('refuses a set whose ordinals are not 0..n-1 in ascending order', () => {
    expect(() => computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...removeGroup, ordinal: 0 }, { ...suspend, ordinal: 5 }],
    })).toThrow(/contiguous/);
  });
});
