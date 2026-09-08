// apps/api/src/services/aiOperator/taskTransitions.test.ts
import { describe, expect, it } from 'vitest';
import { AI_OPERATOR_TASK_STATES } from '../../db/schema/aiOperatorTasks';
import {
  ALL_TASK_STATES,
  TASK_TRANSITIONS,
  TASK_TRANSITION_EVENTS,
  TERMINAL_TASK_STATES,
  TaskTransitionError,
  admissionFenced,
  canTransition,
  isLeasableTaskState,
  isTerminalTaskState,
  nextTaskState,
} from './taskTransitions';

describe('taskTransitions state machine (spec §6.1)', () => {
  it('has a row in TASK_TRANSITIONS for every declared state', () => {
    for (const state of AI_OPERATOR_TASK_STATES) {
      expect(Object.prototype.hasOwnProperty.call(TASK_TRANSITIONS, state)).toBe(true);
    }
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...AI_OPERATOR_TASK_STATES].sort());
    expect(ALL_TASK_STATES).toEqual(AI_OPERATOR_TASK_STATES);
  });

  describe('full state x event cross-product', () => {
    for (const state of AI_OPERATOR_TASK_STATES) {
      for (const event of TASK_TRANSITION_EVENTS) {
        it(`${state} + ${event}`, () => {
          const expected = (TASK_TRANSITIONS[state] as Record<string, string | undefined>)[event];

          expect(canTransition(state, event)).toBe(Boolean(expected));

          if (expected) {
            expect(nextTaskState(state, event)).toBe(expected);
          } else {
            expect(() => nextTaskState(state, event)).toThrow(TaskTransitionError);
          }
        });
      }
    }
  });

  it('terminal states allow ZERO events — records do not restart in place', () => {
    for (const state of TERMINAL_TASK_STATES) {
      for (const event of TASK_TRANSITION_EVENTS) {
        expect(canTransition(state, event)).toBe(false);
        expect(() => nextTaskState(state, event)).toThrow(TaskTransitionError);
      }
    }
  });

  it('isTerminalTaskState agrees with TERMINAL_TASK_STATES', () => {
    for (const state of AI_OPERATOR_TASK_STATES) {
      const expected = (TERMINAL_TASK_STATES as readonly string[]).includes(state);
      expect(isTerminalTaskState(state)).toBe(expected);
    }
  });

  describe('admissionFenced (spec §7.3)', () => {
    it('is true for paused, stopping, and every terminal state', () => {
      expect(admissionFenced('paused')).toBe(true);
      expect(admissionFenced('stopping')).toBe(true);
      for (const state of TERMINAL_TASK_STATES) {
        expect(admissionFenced(state)).toBe(true);
      }
    });

    it('is false for queued, running, and waiting', () => {
      expect(admissionFenced('queued')).toBe(false);
      expect(admissionFenced('running')).toBe(false);
      expect(admissionFenced('waiting')).toBe(false);
    });
  });

  describe('spec §6.1 named edges', () => {
    it('queued -> running on claim', () => {
      expect(nextTaskState('queued', 'claim')).toBe('running');
    });

    it('running -> waiting on wait', () => {
      expect(nextTaskState('running', 'wait')).toBe('waiting');
    });

    it('waiting -> running on claim', () => {
      expect(nextTaskState('waiting', 'claim')).toBe('running');
    });

    it('running -> running on claim (lease reclaim self-transition)', () => {
      expect(nextTaskState('running', 'claim')).toBe('running');
    });

    it('stopping settles to cancelled / expired / handed_off on the three settle events', () => {
      expect(nextTaskState('stopping', 'settle_cancelled')).toBe('cancelled');
      expect(nextTaskState('stopping', 'settle_expired')).toBe('expired');
      expect(nextTaskState('stopping', 'settle_handed_off')).toBe('handed_off');
    });

    it('paused -> running on resume', () => {
      expect(nextTaskState('paused', 'resume')).toBe('running');
    });
  });

  it('LEASABLE_TASK_STATES / isLeasableTaskState matches queued/running/waiting/stopping', () => {
    expect(isLeasableTaskState('queued')).toBe(true);
    expect(isLeasableTaskState('running')).toBe(true);
    expect(isLeasableTaskState('waiting')).toBe(true);
    expect(isLeasableTaskState('stopping')).toBe(true);
    expect(isLeasableTaskState('paused')).toBe(false);
    for (const state of TERMINAL_TASK_STATES) {
      expect(isLeasableTaskState(state)).toBe(false);
    }
  });
});
