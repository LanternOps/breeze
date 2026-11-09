import { describe, expect, it } from 'vitest';
import {
  WISP_CHECK_IN_CONSUME_LIMIT,
  WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES,
  WISP_CHECK_IN_FIRE_REASONS,
  WISP_CHECK_IN_PENDING_STATE_LINES,
  WISP_CHECK_IN_TRIGGER_EVENTS,
  WISP_CHECK_IN_TRIGGER_KINDS,
  WISP_CHECK_IN_INSTRUCTION_MAX,
  WISP_CHECK_IN_MAX_DELAY_MINUTES,
  WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD,
  WISP_CHECK_IN_MIN_DELAY_MINUTES,
  WISP_CHECK_IN_MODES,
  WISP_CHECK_IN_STATUSES,
  WISP_TIMELINE_POST_KINDS,
} from '../index';

describe('wisp check-in constants', () => {
  it('statuses are exactly scheduled, running (W07), fired, consumed, cancelled', () => {
    expect([...WISP_CHECK_IN_STATUSES]).toEqual(['scheduled', 'running', 'fired', 'consumed', 'cancelled']);
  });

  it('W07: modes are exactly notify and run', () => {
    expect([...WISP_CHECK_IN_MODES]).toEqual(['notify', 'run']);
  });

  it('limits match the spec (1 minute to 7 days, 1000 chars, 5 per thread, 5 per turn)', () => {
    expect(WISP_CHECK_IN_MIN_DELAY_MINUTES).toBe(1);
    expect(WISP_CHECK_IN_MAX_DELAY_MINUTES).toBe(7 * 24 * 60);
    expect(WISP_CHECK_IN_INSTRUCTION_MAX).toBe(1000);
    expect(WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD).toBe(5);
    expect(WISP_CHECK_IN_CONSUME_LIMIT).toBe(5);
  });

  it('W04: trigger kinds are time plus the four events; every event has a deadline state line; 24 h default deadline', () => {
    expect([...WISP_CHECK_IN_TRIGGER_KINDS]).toEqual(['time', ...WISP_CHECK_IN_TRIGGER_EVENTS]);
    expect([...WISP_CHECK_IN_TRIGGER_EVENTS]).toEqual(['device_online', 'script_finished', 'command_finished', 'run_settled']);
    expect(Object.keys(WISP_CHECK_IN_PENDING_STATE_LINES).sort()).toEqual([...WISP_CHECK_IN_TRIGGER_EVENTS].sort());
    expect([...WISP_CHECK_IN_FIRE_REASONS]).toEqual(['due', 'event', 'deadline']);
    expect(WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES).toBe(24 * 60);
    expect(WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES).toBeLessThanOrEqual(WISP_CHECK_IN_MAX_DELAY_MINUTES);
  });

  it('WISP_TIMELINE_POST_KINDS keeps check_in (later kinds, e.g. specialist_result #11085, append after it)', () => {
    expect(WISP_TIMELINE_POST_KINDS.slice(0, 4)).toEqual(['brief', 'nudge', 'digest', 'check_in']);
  });
});
