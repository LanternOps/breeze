// packages/shared/src/types/aiOperatorPlanApproval.test.ts
/**
 * Recipe Library spec §5.4 and §6.6. These lists are asserted as VALUES, not
 * only as types: each is mirrored by a CHECK constraint in
 * 2026-10-19-100000-ai-operator-plan-approvals.sql and by an `as const` array
 * in the Drizzle schema, and `enumParity.test.ts` diffs all three. A type-only
 * union cannot be diffed against a CHECK.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES,
  AI_OPERATOR_PLAN_APPROVAL_STATES,
} from './aiOperator';

describe('plan-approval value lists', () => {
  it('AI_OPERATOR_PLAN_APPROVAL_STATES is exactly spec §5.4, in its order', () => {
    expect(AI_OPERATOR_PLAN_APPROVAL_STATES).toEqual([
      'pending', 'approved', 'rejected', 'expired', 'superseded',
    ]);
  });

  it('AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES is exactly spec §6.6', () => {
    expect(AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES).toEqual([
      'idempotent', 'idempotent_by_probe', 'non_idempotent',
    ]);
  });

  it('both lists are frozen, so a caller cannot widen one by push()', () => {
    expect(Object.isFrozen(AI_OPERATOR_PLAN_APPROVAL_STATES)).toBe(true);
    expect(Object.isFrozen(AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES)).toBe(true);
  });
});
