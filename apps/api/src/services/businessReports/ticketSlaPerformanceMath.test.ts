import { describe, expect, it } from 'vitest';
import type { CalendarRevision } from '@breeze/shared';
import {
  durationStats,
  foldPerformance,
  slaClockElapsedMinutes,
  targetMode,
  type DecidedTarget,
} from './ticketSlaPerformanceMath';

/** Mon–Fri 09:00–17:00 UTC. */
const WEEKDAYS: CalendarRevision = {
  timezone: 'UTC',
  intervals: ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
};
const OFFICE = { revision: WEEKDAYS, holidays: [] };

const at = (iso: string) => new Date(iso);

function decided(over: Partial<DecidedTarget> = {}): DecidedTarget {
  return {
    ticketId: 't1',
    ticketNumber: 'T-1',
    subject: null,
    priority: 'normal',
    target: 'response',
    targetMinutes: 60,
    createdAt: at('2026-10-05T09:00:00.000Z'),
    dueAt: at('2026-10-05T10:00:00.000Z'),
    completedAt: at('2026-10-05T09:30:00.000Z'),
    met: true,
    calendarRevisionId: null,
    ...over,
  };
}

const row = (out: ReturnType<typeof foldPerformance>, priority: string) =>
  out.priorities.find((r) => r.priority === priority)!;

describe('slaClockElapsedMinutes', () => {
  it('24×7 on-time response: elapsed = target − (due − completed)', () => {
    expect(slaClockElapsedMinutes(
      { targetMinutes: 60, dueAt: at('2026-10-05T10:00:00Z'), completedAt: at('2026-10-05T09:38:00Z') }, null,
    )).toBe(38);
  });

  it('24×7 late resolution: elapsed = target + (completed − due)', () => {
    expect(slaClockElapsedMinutes(
      { targetMinutes: 240, dueAt: at('2026-10-05T10:00:00Z'), completedAt: at('2026-10-05T10:30:00Z') }, null,
    )).toBe(270);
  });

  it('calendar ticket counts only business minutes across a night', () => {
    // Mon 16:30 → Tue 10:00 is 30 minutes Monday + 60 Tuesday, not 17.5 hours.
    expect(slaClockElapsedMinutes(
      { targetMinutes: 240, dueAt: at('2026-10-06T10:00:00Z'), completedAt: at('2026-10-05T16:30:00Z') }, OFFICE,
    )).toBe(240 - 90);
  });

  it('a late calendar ticket does not charge the night to the target', () => {
    // Due Mon 16:30, completed Tue 10:00: the same 90 open minutes, added this time.
    expect(slaClockElapsedMinutes(
      { targetMinutes: 240, dueAt: at('2026-10-05T16:30:00Z'), completedAt: at('2026-10-06T10:00:00Z') }, OFFICE,
    )).toBe(240 + 90);
  });

  it('elapsed is clamped at 0 and null when not completed', () => {
    expect(slaClockElapsedMinutes(
      { targetMinutes: 10, dueAt: at('2026-10-05T10:00:00Z'), completedAt: at('2026-10-05T09:00:00Z') }, null,
    )).toBe(0);
    expect(slaClockElapsedMinutes(
      { targetMinutes: 10, dueAt: at('2026-10-05T10:00:00Z'), completedAt: null }, null,
    )).toBeNull();
  });
});

describe('durationStats', () => {
  it('median of an even sample is the mean of the two middles, rounded', () => {
    expect(durationStats([10, 20, 31, 40])).toEqual({ median: 26, mean: 25 });
  });

  it('sorts numerically, not as text, and takes the middle of an odd sample', () => {
    expect(durationStats([100, 9, 20])).toEqual({ median: 20, mean: 43 });
  });

  it('empty sample → null median and mean', () => {
    expect(durationStats([])).toEqual({ median: null, mean: null });
  });
});

describe('targetMode', () => {
  it('targetMode picks the most common, smallest on a tie, varies when >1 distinct', () => {
    expect(targetMode([60, 60, 30])).toEqual({ minutes: 60, varies: true });
    expect(targetMode([30, 60])).toEqual({ minutes: 30, varies: true });
    expect(targetMode([60, 30])).toEqual({ minutes: 30, varies: true });
    expect(targetMode([60])).toEqual({ minutes: 60, varies: false });
    expect(targetMode([])).toEqual({ minutes: null, varies: false });
  });
});

describe('foldPerformance', () => {
  it("fold always emits four priorities urgent→low and an 'all' overall", () => {
    const out = foldPerformance([], [], new Map());
    expect(out.priorities.map((r) => r.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(out.overall.priority).toBe('all');
    expect(out.overall.responseAttainment).toBeNull();
    expect(out.overall.responseMedianMinutes).toBeNull();
    expect(out.breaches).toEqual([]);
    expect(out.unmeasuredDurations).toBe(0);
  });

  it('counts met, missed and attainment per priority and per kind, and sums into overall', () => {
    const out = foldPerformance([
      decided({ ticketId: 'a', priority: 'urgent' }),
      decided({ ticketId: 'b', priority: 'urgent', met: false, completedAt: at('2026-10-05T10:30:00Z') }),
      decided({ ticketId: 'c', priority: 'low', target: 'resolution', targetMinutes: 240 }),
    ], [], new Map());
    const urgent = row(out, 'urgent');
    expect(urgent.responseMeasured).toBe(2);
    expect(urgent.responseMet).toBe(1);
    expect(urgent.responseMissed).toBe(1);
    expect(urgent.responseAttainment).toBe(0.5);
    expect(urgent.resolutionMeasured).toBe(0);
    expect(urgent.resolutionAttainment).toBeNull();
    const low = row(out, 'low');
    expect(low.resolutionMet).toBe(1);
    expect(low.resolutionAttainment).toBe(1);
    expect(out.overall.responseMeasured).toBe(2);
    expect(out.overall.resolutionMeasured).toBe(1);
  });

  it('medians are per priority, and overall is computed over the pooled sample', () => {
    const out = foldPerformance([
      // Elapsed 10, 20 and 90 minutes; the pooled median is 20, not a median of medians.
      decided({ ticketId: 'a', priority: 'urgent', completedAt: at('2026-10-05T09:10:00Z') }),
      decided({ ticketId: 'b', priority: 'urgent', completedAt: at('2026-10-05T09:20:00Z') }),
      decided({ ticketId: 'c', priority: 'low', met: false, completedAt: at('2026-10-05T10:30:00Z') }),
    ], [], new Map());
    expect(row(out, 'urgent').responseMedianMinutes).toBe(15);
    expect(row(out, 'low').responseMedianMinutes).toBe(90);
    expect(out.overall.responseMedianMinutes).toBe(20);
    expect(out.overall.responseMeanMinutes).toBe(40);
    expect(out.overall.responseTimedSample).toBe(3);
  });

  it('reports the mode target per kind, and the mode across all priorities on the overall row', () => {
    const out = foldPerformance([
      decided({ ticketId: 'a', priority: 'urgent', targetMinutes: 30 }),
      decided({ ticketId: 'b', priority: 'urgent', targetMinutes: 30 }),
      decided({ ticketId: 'c', priority: 'urgent', targetMinutes: 60 }),
      decided({ ticketId: 'd', priority: 'low', targetMinutes: 60 }),
    ], [], new Map());
    expect(row(out, 'urgent').responseTargetMinutes).toBe(30);
    expect(row(out, 'urgent').responseTargetVaries).toBe(true);
    expect(row(out, 'low').responseTargetMinutes).toBe(60);
    expect(row(out, 'low').responseTargetVaries).toBe(false);
    expect(row(out, 'high').responseTargetMinutes).toBeNull();
    expect(out.overall.responseTargetVaries).toBe(true);
  });

  it('volume comes from the opened counts, summed into overall, and is not a denominator', () => {
    const out = foldPerformance([], [
      { priority: 'urgent', opened: 3, withoutTarget: 1 },
      { priority: 'low', opened: 2, withoutTarget: 0 },
    ], new Map());
    expect(row(out, 'urgent').ticketsOpened).toBe(3);
    expect(row(out, 'urgent').ticketsWithoutTarget).toBe(1);
    expect(row(out, 'high').ticketsOpened).toBe(0);
    expect(out.overall.ticketsOpened).toBe(5);
    expect(out.overall.ticketsWithoutTarget).toBe(1);
    expect(out.overall.responseAttainment).toBeNull();
  });

  it('a target whose calendar revision cannot be loaded counts for attainment but not durations', () => {
    const out = foldPerformance([
      decided({ ticketId: 'a', calendarRevisionId: 'rev-gone' }),
      decided({ ticketId: 'b', calendarRevisionId: 'rev-gone', met: false, completedAt: at('2026-10-05T10:30:00Z') }),
    ], [], new Map());
    const normal = row(out, 'normal');
    expect(normal.responseMeasured).toBe(2);
    expect(normal.responseAttainment).toBe(0.5);
    expect(normal.responseTimedSample).toBe(0);
    expect(normal.responseMedianMinutes).toBeNull();
    expect(out.unmeasuredDurations).toBe(2);
    expect(out.breaches[0]!.elapsedSlaMinutes).toBeNull();
    expect(out.breaches[0]!.overByMinutes).toBeNull();
  });

  it('a loaded calendar is used, and an open missed target never counts as unmeasured', () => {
    const out = foldPerformance([
      decided({
        calendarRevisionId: 'rev-1',
        targetMinutes: 240,
        dueAt: at('2026-10-06T10:00:00Z'),
        completedAt: at('2026-10-05T16:30:00Z'),
      }),
      decided({ ticketId: 'b', calendarRevisionId: 'rev-gone', met: false, completedAt: null }),
    ], [], new Map([['rev-1', OFFICE]]));
    expect(row(out, 'normal').responseMedianMinutes).toBe(150);
    expect(out.unmeasuredDurations).toBe(0);
  });

  it('missed and still open counts in missedOpen, not in the timed sample', () => {
    const out = foldPerformance([
      decided({ ticketId: 'a', met: false, completedAt: null }),
      decided({ ticketId: 'b', met: false, completedAt: at('2026-10-05T10:30:00Z') }),
    ], [], new Map());
    const normal = row(out, 'normal');
    expect(normal.responseMissed).toBe(2);
    expect(normal.responseMissedOpen).toBe(1);
    expect(normal.responseTimedSample).toBe(1);
    expect(normal.responseMedianMinutes).toBe(90);
    expect(out.overall.responseMissedOpen).toBe(1);
  });

  it('breaches are every missed target in input order, with over-by minutes and ISO instants', () => {
    const out = foldPerformance([
      decided({ ticketId: 'ok' }),
      decided({ ticketId: 'b1', ticketNumber: 'T-9', subject: 's', met: false, completedAt: at('2026-10-05T10:30:00Z') }),
      decided({ ticketId: 'b2', target: 'resolution', targetMinutes: 240, met: false, completedAt: null }),
    ], [], new Map());
    expect(out.breaches.map((b) => b.ticketId)).toEqual(['b1', 'b2']);
    expect(out.breaches[0]).toEqual({
      ticketId: 'b1',
      ticketNumber: 'T-9',
      subject: 's',
      priority: 'normal',
      target: 'response',
      targetMinutes: 60,
      createdAt: '2026-10-05T09:00:00.000Z',
      dueAt: '2026-10-05T10:00:00.000Z',
      completedAt: '2026-10-05T10:30:00.000Z',
      elapsedSlaMinutes: 90,
      overByMinutes: 30,
    });
    expect(out.breaches[1]!.completedAt).toBeNull();
    expect(out.breaches[1]!.elapsedSlaMinutes).toBeNull();
    expect(out.breaches[1]!.overByMinutes).toBeNull();
  });

  it('elapsed rounds to whole minutes in the breach row and the stats', () => {
    const out = foldPerformance([
      decided({ met: false, completedAt: at('2026-10-05T10:00:40.000Z') }),
    ], [], new Map());
    expect(out.breaches[0]!.elapsedSlaMinutes).toBe(61);
    expect(row(out, 'normal').responseMedianMinutes).toBe(61);
  });
});
