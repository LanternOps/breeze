/**
 * `isTaskFenced` — the predicate the run loop's pre-tool hook evaluates on
 * EVERY tool call of a task-linked run (#5205 W06, spec §7.3).
 *
 * WHY THIS DESERVES ITS OWN EXHAUSTIVE SUITE. There is no run-level cancel in
 * this codebase (baseline C17: `cancelled`/`expired` are valid
 * `ai_agent_runs` statuses with zero production writers and no route). So a
 * cancelled, paused, expired or retargeted task CANNOT stop its in-flight
 * reasoning run by cancelling it — this predicate IS the cancel. If it ever
 * returns `false` where it should return `true`, a task the operator believes
 * they stopped keeps proposing and executing real effects on a customer
 * device, and nothing anywhere errors.
 *
 * The cross-product below is deliberately exhaustive over every declared task
 * state rather than spot-checking the interesting ones: a twelfth state added
 * to `AI_OPERATOR_TASK_STATES` without a decision about whether it fences
 * would otherwise slip through as "not fenced" by default.
 */
import { describe, expect, it } from 'vitest';
import { AI_OPERATOR_TASK_STATES } from '../../db/schema/aiOperatorTasks';
import { isTaskFenced } from './taskService';
import { TERMINAL_TASK_STATES } from './taskTransitions';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 60_000);
const PAST = new Date(NOW.getTime() - 1);

/** A task that is live, on-target, and inside its deadline. */
const clear = (state: string) => ({
  state,
  targetDetachedAt: null,
  deadlineAt: FUTURE,
});

describe('isTaskFenced — state axis', () => {
  it.each([...AI_OPERATOR_TASK_STATES])('%s', (state) => {
    const fencedByState =
      state === 'paused'
      || state === 'stopping'
      || (TERMINAL_TASK_STATES as readonly string[]).includes(state);

    expect(isTaskFenced(clear(state), NOW)).toBe(fencedByState);
  });

  it('fences exactly the states that must refuse new work, and no others', () => {
    // Written as an explicit literal set rather than derived from the same
    // helper the implementation uses — a derived expectation would follow the
    // implementation wherever it went, which is the whole failure mode this
    // assertion exists to prevent.
    const fenced = AI_OPERATOR_TASK_STATES.filter((s) => isTaskFenced(clear(s), NOW));
    expect([...fenced].sort()).toEqual([
      'cancelled', 'completed', 'expired', 'failed', 'handed_off',
      'partial', 'paused', 'stopping',
    ]);
  });

  it('does NOT fence a live task', () => {
    for (const state of ['queued', 'running', 'waiting'] as const) {
      expect(isTaskFenced(clear(state), NOW)).toBe(false);
    }
  });
});

describe('isTaskFenced — target detachment', () => {
  it('fences a live task whose target has been detached', () => {
    // The device moved org or was deleted, so the frozen scope no longer
    // resolves to anything this task may touch.
    expect(isTaskFenced({ ...clear('running'), targetDetachedAt: PAST }, NOW)).toBe(true);
    expect(isTaskFenced({ ...clear('waiting'), targetDetachedAt: PAST }, NOW)).toBe(true);
    expect(isTaskFenced({ ...clear('queued'), targetDetachedAt: PAST }, NOW)).toBe(true);
  });

  it('a FUTURE detached_at still fences — the column is a marker, not a schedule', () => {
    // `target_detached_at` records WHEN detachment happened; nothing writes a
    // future value. Treating a future timestamp as "not yet detached" would
    // invent a semantic the writers do not have.
    expect(isTaskFenced({ ...clear('running'), targetDetachedAt: FUTURE }, NOW)).toBe(true);
  });
});

describe('isTaskFenced — deadline', () => {
  it('fences the instant the deadline passes, not when a poller notices', () => {
    expect(isTaskFenced({ ...clear('running'), deadlineAt: PAST }, NOW)).toBe(true);
    // Exactly at the deadline is past it.
    expect(isTaskFenced({ ...clear('running'), deadlineAt: NOW }, NOW)).toBe(true);
    expect(isTaskFenced({ ...clear('running'), deadlineAt: FUTURE }, NOW)).toBe(false);
  });

  it('does NOT fence on a NULL deadline', () => {
    // Deliberate: admission always sets one, and the place that fails closed
    // on its absence is the dispatch claim (`evaluateTaskClaimPredicate`,
    // "absence of a bound is not permission") — which is the linearization
    // point. Fencing here too would only change which one refuses first.
    expect(isTaskFenced({ ...clear('running'), deadlineAt: null }, NOW)).toBe(false);
  });
});

describe('isTaskFenced — the axes are independent', () => {
  it('any ONE reason fences, regardless of the other two', () => {
    const cases: Array<[string, Parameters<typeof isTaskFenced>[0]]> = [
      ['state only', { state: 'stopping', targetDetachedAt: null, deadlineAt: FUTURE }],
      ['target only', { state: 'running', targetDetachedAt: PAST, deadlineAt: FUTURE }],
      ['deadline only', { state: 'running', targetDetachedAt: null, deadlineAt: PAST }],
      ['all three', { state: 'cancelled', targetDetachedAt: PAST, deadlineAt: PAST }],
    ];
    for (const [label, task] of cases) {
      expect(isTaskFenced(task, NOW), label).toBe(true);
    }
  });

  it('defaults `now` to the current time when not supplied', () => {
    // The pre-hook calls `loadTaskFence`, which does not pass a clock.
    expect(isTaskFenced({
      state: 'running', targetDetachedAt: null, deadlineAt: new Date(Date.now() - 1_000),
    })).toBe(true);
    expect(isTaskFenced({
      state: 'running', targetDetachedAt: null, deadlineAt: new Date(Date.now() + 60_000),
    })).toBe(false);
  });
});
