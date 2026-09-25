/**
 * The five v15 task-wide budgets enforced by #6590 (Operator spec §7.2 /
 * recipe spec §6.7). Every check is exercised UNDER, AT and OVER its limit,
 * and every refusal must name the limit that fired — a refusal that only says
 * "limit reached" leaves the technician unable to tell a recipe bound from an
 * org policy override.
 */
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import {
  checkTaskActiveTargets,
  checkTaskBudget,
  checkTaskMutationAttempts,
  checkTaskPendingCapacity,
  checkTaskReasoningRuns,
} from './taskLimits';

describe('checkTaskReasoningRuns (taskMaxReasoningRuns)', () => {
  // attemptOrdinal is 0-based: ordinal N is the (N+1)th run.
  it('admits under the policy ceiling', () => {
    expect(checkTaskReasoningRuns({ attemptOrdinal: 1, recipeBound: 10, policyLimits: { taskMaxReasoningRuns: 3 } }))
      .toEqual({ ok: true });
  });

  it('refuses AT the policy ceiling when the policy is narrower than the recipe', () => {
    const result = checkTaskReasoningRuns({
      attemptOrdinal: 3, recipeBound: 10, policyLimits: { taskMaxReasoningRuns: 3 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('reasoning-run limit reached (3');
    expect(!result.ok && result.detail).toContain('taskMaxReasoningRuns');
  });

  it('refuses OVER the ceiling', () => {
    expect(checkTaskReasoningRuns({ attemptOrdinal: 5, recipeBound: 10, policyLimits: { taskMaxReasoningRuns: 3 } }).ok)
      .toBe(false);
  });

  it('takes the recipe bound when it is narrower, and says so', () => {
    const result = checkTaskReasoningRuns({ attemptOrdinal: 2, recipeBound: 2, policyLimits: { taskMaxReasoningRuns: 6 } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('bounds.maxReasoningRuns');
  });

  it('a missing ceiling (pre-v15 snapshot or no policy) is the DEFAULT, never unbounded', () => {
    const at = AI_AGENT_LIMIT_DEFAULTS.taskMaxReasoningRuns;
    expect(checkTaskReasoningRuns({ attemptOrdinal: at, recipeBound: 100, policyLimits: null }).ok).toBe(false);
    expect(checkTaskReasoningRuns({ attemptOrdinal: at, recipeBound: 100, policyLimits: {} }).ok).toBe(false);
    expect(checkTaskReasoningRuns({ attemptOrdinal: at - 1, recipeBound: 100, policyLimits: null }).ok).toBe(true);
  });
});

describe('checkTaskMutationAttempts (taskMaxMutationAttemptsPerTarget)', () => {
  it('admits under', () => {
    expect(checkTaskMutationAttempts({
      mutationAttempts: 1, recipeBound: 5, policyLimits: { taskMaxMutationAttemptsPerTarget: 2 },
    })).toEqual({ ok: true });
  });

  it('refuses at, naming the policy ceiling', () => {
    const result = checkTaskMutationAttempts({
      mutationAttempts: 2, recipeBound: 5, policyLimits: { taskMaxMutationAttemptsPerTarget: 2 },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('taskMaxMutationAttemptsPerTarget');
  });

  it('refuses over', () => {
    expect(checkTaskMutationAttempts({
      mutationAttempts: 4, recipeBound: 5, policyLimits: { taskMaxMutationAttemptsPerTarget: 2 },
    }).ok).toBe(false);
  });

  it('the recipe bound wins when narrower', () => {
    const result = checkTaskMutationAttempts({
      mutationAttempts: 1, recipeBound: 1, policyLimits: { taskMaxMutationAttemptsPerTarget: 3 },
    });
    expect(!result.ok && result.detail).toContain('bounds.maxMutationAttempts');
  });

  it('falls back to the default ceiling', () => {
    const at = AI_AGENT_LIMIT_DEFAULTS.taskMaxMutationAttemptsPerTarget;
    expect(checkTaskMutationAttempts({ mutationAttempts: at, recipeBound: 10, policyLimits: null }).ok).toBe(false);
  });
});

describe('checkTaskBudget (taskMaxBudgetCents)', () => {
  it('admits under', () => {
    expect(checkTaskBudget({ spentCents: 199, policyLimits: { taskMaxBudgetCents: 200 } })).toEqual({ ok: true });
  });

  it('refuses at, reporting spend and ceiling', () => {
    const result = checkTaskBudget({ spentCents: 200, policyLimits: { taskMaxBudgetCents: 200 } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('200');
    expect(!result.ok && result.detail).toContain('taskMaxBudgetCents');
  });

  it('refuses over', () => {
    expect(checkTaskBudget({ spentCents: 450, policyLimits: { taskMaxBudgetCents: 200 } }).ok).toBe(false);
  });

  it('falls back to the default ceiling', () => {
    expect(checkTaskBudget({ spentCents: AI_AGENT_LIMIT_DEFAULTS.taskMaxBudgetCents, policyLimits: null }).ok)
      .toBe(false);
  });
});

describe('checkTaskActiveTargets (taskMaxActiveTargets)', () => {
  // This one counts targets the task WOULD hold, so reaching the ceiling
  // exactly is allowed and only exceeding it refuses.
  it('admits under', () => {
    expect(checkTaskActiveTargets({ targetCount: 1, policyLimits: { taskMaxActiveTargets: 3 } })).toEqual({ ok: true });
  });

  it('admits at', () => {
    expect(checkTaskActiveTargets({ targetCount: 3, policyLimits: { taskMaxActiveTargets: 3 } })).toEqual({ ok: true });
  });

  it('refuses over, naming the ceiling', () => {
    const result = checkTaskActiveTargets({ targetCount: 4, policyLimits: { taskMaxActiveTargets: 3 } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('taskMaxActiveTargets');
  });

  it('falls back to the default ceiling (1)', () => {
    expect(checkTaskActiveTargets({ targetCount: 2, policyLimits: null }).ok).toBe(false);
    expect(checkTaskActiveTargets({ targetCount: 1, policyLimits: null }).ok).toBe(true);
  });
});

describe('checkTaskPendingCapacity (taskMaxPendingPerOrg)', () => {
  // `pendingCount` is the org's live tasks BEFORE this admission.
  it('admits under', () => {
    expect(checkTaskPendingCapacity({ pendingCount: 9, policyLimits: { taskMaxPendingPerOrg: 10 } }))
      .toEqual({ ok: true });
  });

  it('refuses at', () => {
    const result = checkTaskPendingCapacity({ pendingCount: 10, policyLimits: { taskMaxPendingPerOrg: 10 } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toContain('taskMaxPendingPerOrg');
  });

  it('refuses over', () => {
    expect(checkTaskPendingCapacity({ pendingCount: 12, policyLimits: { taskMaxPendingPerOrg: 10 } }).ok).toBe(false);
  });

  it('falls back to the default ceiling', () => {
    const at = AI_AGENT_LIMIT_DEFAULTS.taskMaxPendingPerOrg;
    expect(checkTaskPendingCapacity({ pendingCount: at, policyLimits: null }).ok).toBe(false);
    expect(checkTaskPendingCapacity({ pendingCount: at - 1, policyLimits: null }).ok).toBe(true);
  });
});
