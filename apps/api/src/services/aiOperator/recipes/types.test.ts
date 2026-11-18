/**
 * Operator Recipe Library spec §6.1: the recipe contract. These are the
 * runtime halves of the unions the spec fixes — §6.1's `StepKind`, §5.1's
 * `target_kind` CHECK list, §9's gate classes. They are asserted as VALUES,
 * not only as types, because a type-only union cannot be diffed against the
 * database CHECK constraint that E2 will add for the same list, and the
 * aiOperator family has already paid for hand-duplicated unions drifting
 * (see `enumParity.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { serviceRecoveryRecipe } from './serviceRecovery';
import { CAPABILITY_AVAILABILITIES, RECIPE_GATE_CLASSES, STEP_KINDS, TARGET_KINDS } from './types';

describe('recipe contract unions (spec §6.1, §5.1, §9)', () => {
  it('STEP_KINDS is exactly the spec §6.1 step-kind table, in its order', () => {
    expect(STEP_KINDS).toEqual(['reason', 'effect', 'probe', 'wait', 'human_work', 'document']);
  });

  it('TARGET_KINDS is exactly the spec §5.1 target_kind CHECK list', () => {
    expect(TARGET_KINDS).toEqual(['device', 'ticket', 'contact']);
  });

  it('RECIPE_GATE_CLASSES is exactly the spec §9 gate classes', () => {
    expect(RECIPE_GATE_CLASSES).toEqual(['deterministic', 'model_chooses_effect']);
  });

  it('every union is frozen at runtime so a caller cannot widen it by push()', () => {
    expect(Object.isFrozen(STEP_KINDS)).toBe(true);
    expect(Object.isFrozen(TARGET_KINDS)).toBe(true);
    expect(Object.isFrozen(RECIPE_GATE_CLASSES)).toBe(true);
  });
});

describe('R1 additive contract fields', () => {
  it('service_recovery declares no deterministic `next` on any step (R1 additive-field proof)', () => {
    for (const [key, step] of Object.entries(serviceRecoveryRecipe.steps)) {
      expect(step.next, `service_recovery.${key} must not declare next`).toBeUndefined();
    }
  });

  it('an unclassified capability defaults to tenant_fixable — the blocking, safe reading', () => {
    // Asserted on the TYPE's default rather than on a recipe, because the
    // consequence of the default is which way an unclassified capability
    // pushes readiness, and getting that backwards would silently mark a
    // fixable setup gap as a permanent product gap.
    expect(CAPABILITY_AVAILABILITIES).toEqual(['tenant_fixable', 'always_manual']);
    expect(Object.isFrozen(CAPABILITY_AVAILABILITIES)).toBe(true);
    for (const cap of serviceRecoveryRecipe.requires) {
      expect(cap.availability ?? 'tenant_fixable').toBe('tenant_fixable');
    }
  });

  it('service_recovery.operationKey is byte-identical with and without the new toolName arg', () => {
    const base = { stepKey: 'execute', targetId: 'device-1', planRevision: 2, ordinal: 0 };
    expect(serviceRecoveryRecipe.operationKey(base))
      .toBe(serviceRecoveryRecipe.operationKey({ ...base, toolName: undefined }));
    // And the new argument, when supplied, actually reaches the key — a
    // pass-through that silently dropped it would let R1's recipe and E4's
    // dispatcher disagree about an operation's identity, which is the one
    // thing the permanent (org_id, task_id, operation_key) index rests on.
    expect(serviceRecoveryRecipe.operationKey({ ...base, toolName: 'zzz_probe' })).toContain('zzz_probe');
  });
});
