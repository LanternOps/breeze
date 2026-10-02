import { describe, expect, it } from 'vitest';
import { reminderDueToday } from './reminderSweep';

const input = {
  dueDate: '2026-10-08', today: '2026-10-05', beforeDueDays: 3,
  repeatDays: null, overdueEveryDays: 7, lastSentSeq: 0,
};

describe('reminderDueToday', () => {
  it.each([
    ['2026-10-04', null],
    ['2026-10-05', { kind: 'payment_reminder', seq: 1 }],
    ['2026-10-06', null],
    ['2026-10-08', null],
    ['2026-10-09', null],
    ['2026-10-14', null],
    ['2026-10-15', { kind: 'payment_overdue', seq: 1 }],
    ['2026-10-22', { kind: 'payment_overdue', seq: 2 }],
  ])('evaluates %s with no upcoming repeats', (today, expected) => {
    expect(reminderDueToday({ ...input, today: today as string })).toEqual(expected);
  });
  it.each([
    ['2026-10-01', 1], ['2026-10-03', 2], ['2026-10-05', 3], ['2026-10-07', 4],
  ])('numbers upcoming repeats on %s', (today, seq) => {
    expect(reminderDueToday({ ...input, today, beforeDueDays: 7, repeatDays: 2 }))
      .toEqual({ kind: 'payment_reminder', seq });
  });
  it('does not backfill a missed tick or send on the due date', () => {
    expect(reminderDueToday({ ...input, today: '2026-10-04', beforeDueDays: 7, repeatDays: 2 })).toBeNull();
    expect(reminderDueToday({ ...input, today: input.dueDate, repeatDays: 1 })).toBeNull();
  });
  it('suppresses allocated sequences after retry or cadence edits', () => {
    expect(reminderDueToday({ ...input, lastSentSeq: 1 })).toBeNull();
    expect(reminderDueToday({ ...input, today: '2026-10-15', lastSentSeq: 2 })).toBeNull();
    expect(reminderDueToday({ ...input, today: '2026-10-29', lastSentSeq: 2 }))
      .toEqual({ kind: 'payment_overdue', seq: 3 });
  });
  it.each([
    ['2028-03-01', '2028-02-29'],
    ['2026-11-02', '2026-11-01'],
    ['2027-01-01', '2026-12-31'],
  ])('uses UTC calendar days across %s', (dueDate, today) => {
    expect(reminderDueToday({ ...input, dueDate, today, beforeDueDays: 1 }))
      .toEqual({ kind: 'payment_reminder', seq: 1 });
  });
  it.each([
    { dueDate: '2026-02-30' }, { today: '2026-10-05T00:00:00Z' },
    { beforeDueDays: 0 }, { beforeDueDays: 32 }, { repeatDays: 0 },
    { repeatDays: 1.5 }, { overdueEveryDays: 32 }, { lastSentSeq: -1 },
  ])('rejects corrupt inputs %j', (patch) => {
    expect(() => reminderDueToday({ ...input, ...patch })).toThrow(RangeError);
  });
});
