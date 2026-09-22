/**
 * Task deadline resolution (Recipe Library wave E2, #6167): the one v15
 * task-wide budget this wave actually enforces. Operator spec §7.2 / recipe
 * spec §6.7 — a recipe's bound may be stricter than the agent policy's
 * ceiling, never looser, and the narrower of the two applies.
 */
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { resolveTaskDeadlineMs } from './taskDeadline';

const HOUR = 3_600_000;
const noJitter = () => 1;

describe('resolveTaskDeadlineMs', () => {
  it('a 1-hour policy ceiling wins over the recipe 24-hour default', () => {
    expect(resolveTaskDeadlineMs({
      requestedMs: undefined, recipeDeadlineMs: 24 * HOUR,
      policyLimits: { taskDeadlineHours: 1 }, jitter: noJitter,
    })).toBe(HOUR);
  });

  it('the recipe bound wins when it is the stricter of the two', () => {
    expect(resolveTaskDeadlineMs({
      requestedMs: undefined, recipeDeadlineMs: 24 * HOUR,
      policyLimits: { taskDeadlineHours: 72 }, jitter: noJitter,
    })).toBe(24 * HOUR);
  });

  it('a caller-requested deadline cannot exceed the policy ceiling', () => {
    expect(resolveTaskDeadlineMs({
      requestedMs: 500 * HOUR, recipeDeadlineMs: 24 * HOUR,
      policyLimits: { taskDeadlineHours: 48 }, jitter: noJitter,
    })).toBe(48 * HOUR);
  });

  it('a pre-v15 snapshot (no field) falls back to the default ceiling, not to unbounded', () => {
    expect(resolveTaskDeadlineMs({
      requestedMs: 500 * HOUR, recipeDeadlineMs: 24 * HOUR,
      policyLimits: {}, jitter: noJitter,
    })).toBe(AI_AGENT_LIMIT_DEFAULTS.taskDeadlineHours * HOUR);
  });

  it('no resolvable policy at all also falls back to the default ceiling', () => {
    expect(resolveTaskDeadlineMs({
      requestedMs: 500 * HOUR, recipeDeadlineMs: 24 * HOUR,
      policyLimits: null, jitter: noJitter,
    })).toBe(AI_AGENT_LIMIT_DEFAULTS.taskDeadlineHours * HOUR);
  });

  it('the anti-thundering-herd jitter spreads deadlines but never past the ceiling', () => {
    // +10% jitter on a deadline that already sits AT the ceiling must clamp.
    expect(resolveTaskDeadlineMs({
      requestedMs: undefined, recipeDeadlineMs: 24 * HOUR,
      policyLimits: { taskDeadlineHours: 1 }, jitter: () => 1.1,
    })).toBe(HOUR);
    // -10% is allowed: it only makes the task stricter.
    expect(resolveTaskDeadlineMs({
      requestedMs: undefined, recipeDeadlineMs: 24 * HOUR,
      policyLimits: { taskDeadlineHours: 72 }, jitter: () => 0.9,
    })).toBe(Math.round(24 * HOUR * 0.9));
  });
});
