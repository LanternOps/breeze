import { describe, expect, it } from 'vitest';
import {
  WISP_CHECK_IN_CONSUME_LIMIT,
  WISP_CHECK_IN_INSTRUCTION_MAX,
  WISP_CHECK_IN_MAX_DELAY_MINUTES,
  WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD,
  WISP_CHECK_IN_MIN_DELAY_MINUTES,
  WISP_CHECK_IN_STATUSES,
  WISP_TIMELINE_POST_KINDS,
} from '../index';

describe('wisp check-in constants', () => {
  it('statuses are exactly scheduled, fired, consumed, cancelled', () => {
    expect([...WISP_CHECK_IN_STATUSES]).toEqual(['scheduled', 'fired', 'consumed', 'cancelled']);
  });

  it('limits match the spec (1 minute to 7 days, 1000 chars, 5 per thread, 5 per turn)', () => {
    expect(WISP_CHECK_IN_MIN_DELAY_MINUTES).toBe(1);
    expect(WISP_CHECK_IN_MAX_DELAY_MINUTES).toBe(7 * 24 * 60);
    expect(WISP_CHECK_IN_INSTRUCTION_MAX).toBe(1000);
    expect(WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD).toBe(5);
    expect(WISP_CHECK_IN_CONSUME_LIMIT).toBe(5);
  });

  it('WISP_TIMELINE_POST_KINDS ends with check_in', () => {
    expect([...WISP_TIMELINE_POST_KINDS]).toEqual(['brief', 'nudge', 'digest', 'check_in']);
  });
});
