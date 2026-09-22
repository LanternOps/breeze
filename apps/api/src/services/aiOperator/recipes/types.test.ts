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
import { RECIPE_GATE_CLASSES, STEP_KINDS, TARGET_KINDS } from './types';

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
