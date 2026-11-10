import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_CONSUMING_OUTCOMES,
  OEM_MAX_ATTEMPTS_PER_OCCURRENCE,
  computeOccurrence,
  consumesAttempt,
  occurrenceBoundaries,
  nightlyWindow,
  notAfterFor,
  stableOffsetMinutes,
  type OemOccurrenceSchedule,
} from './occurrence';

const NY = 'America/New_York';

function schedule(over: Partial<OemOccurrenceSchedule> = {}): OemOccurrenceSchedule {
  return { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4, catchUpNights: 7, ...over };
}

const MINUTE = 60_000;

describe('computeOccurrence: the anchor date', () => {
  it('finds the third Wednesday of every month of a year', () => {
    const thirdWednesdays2027: Array<[string, string]> = [
      ['2027-01', '2027-01-20'],
      ['2027-02', '2027-02-17'],
      ['2027-03', '2027-03-17'],
      ['2027-04', '2027-04-21'],
      ['2027-05', '2027-05-19'],
      ['2027-06', '2027-06-16'],
      ['2027-07', '2027-07-21'],
      ['2027-08', '2027-08-18'],
      ['2027-09', '2027-09-15'],
      ['2027-10', '2027-10-20'],
      ['2027-11', '2027-11-17'],
      ['2027-12', '2027-12-15'],
    ];
    for (const [key, date] of thirdWednesdays2027) {
      // 02:00 UTC on the anchor date is inside the 01:00 UTC window.
      const result = computeOccurrence(schedule(), 'UTC', new Date(`${date}T02:00:00.000Z`));
      expect(result.occurrenceKey, date).toBe(key);
      expect(result.nightIndex, date).toBe(0);
      expect(result.inWindow, date).toBe(true);
      const { year, month, day } = result.anchorDate;
      expect(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`).toBe(date);
    }
  });

  it('finds the last weekday of February, in a common and a leap year', () => {
    const common = computeOccurrence(schedule({ weekOfMonth: 'last', dayOfWeek: 'sun' }), 'UTC', new Date('2027-02-28T02:00:00.000Z'));
    expect(common.anchorDate).toEqual({ year: 2027, month: 2, day: 28 });
    expect(common.nightIndex).toBe(0);

    const leap = computeOccurrence(schedule({ weekOfMonth: 'last', dayOfWeek: 'tue' }), 'UTC', new Date('2028-02-29T02:00:00.000Z'));
    expect(leap.anchorDate).toEqual({ year: 2028, month: 2, day: 29 });
    expect(leap.nightIndex).toBe(0);
  });

  it('reads the anchor in device-local time, not UTC', () => {
    // 01:30 New York on 20 Jan is 06:30 UTC: the anchor night there.
    const ny = computeOccurrence(schedule(), NY, new Date('2027-01-20T06:30:00.000Z'));
    expect(ny.nightIndex).toBe(0);
    // The same instant in Tokyo is 15:30 on the anchor date: daytime, out of the window.
    const tokyo = computeOccurrence(schedule(), 'Asia/Tokyo', new Date('2027-01-20T06:30:00.000Z'));
    expect(tokyo.inWindow).toBe(false);
  });
});

describe('computeOccurrence: the window', () => {
  it('is in the window only between its start and its end', () => {
    const before = computeOccurrence(schedule(), 'UTC', new Date('2027-01-20T00:59:00.000Z'));
    const start = computeOccurrence(schedule(), 'UTC', new Date('2027-01-20T01:00:00.000Z'));
    const last = computeOccurrence(schedule(), 'UTC', new Date('2027-01-20T04:59:00.000Z'));
    const end = computeOccurrence(schedule(), 'UTC', new Date('2027-01-20T05:00:00.000Z'));
    expect(before.inWindow).toBe(false);
    expect(start.inWindow).toBe(true);
    expect(start.windowStart).toEqual(new Date('2027-01-20T01:00:00.000Z'));
    expect(start.windowEnd).toEqual(new Date('2027-01-20T05:00:00.000Z'));
    expect(start.windowMinutes).toBe(240);
    expect(last.inWindow).toBe(true);
    expect(end.inWindow).toBe(false);
    expect(end.nightIndex).toBeNull();
  });

  it('a window crossing midnight stays one night', () => {
    const late = schedule({ windowStart: '23:00', windowHours: 4 });
    const beforeMidnight = computeOccurrence(late, 'UTC', new Date('2027-01-20T23:30:00.000Z'));
    const afterMidnight = computeOccurrence(late, 'UTC', new Date('2027-01-21T02:30:00.000Z'));
    expect(beforeMidnight.nightIndex).toBe(0);
    expect(afterMidnight.nightIndex).toBe(0);
    expect(afterMidnight.windowStart).toEqual(beforeMidnight.windowStart);
    expect(afterMidnight.windowEnd).toEqual(new Date('2027-01-21T03:00:00.000Z'));
  });

  it('a window opening on the last night of a month and closing in the next keeps its key', () => {
    // Last Sunday of January 2027 is the 31st.
    const late = schedule({ weekOfMonth: 'last', dayOfWeek: 'sun', windowStart: '23:00', windowHours: 4, catchUpNights: 0 });
    const result = computeOccurrence(late, 'UTC', new Date('2027-02-01T01:00:00.000Z'));
    expect(result.occurrenceKey).toBe('2027-01');
    expect(result.nightIndex).toBe(0);
    expect(result.inWindow).toBe(true);
  });
});

describe('computeOccurrence: daylight saving', () => {
  // 2027-03-14 is the second Sunday of March: New York skips 02:00 to 03:00.
  const gapNight = schedule({ weekOfMonth: 'second', dayOfWeek: 'sun', windowStart: '02:30', windowHours: 4 });

  function inWindowRuns(sched: OemOccurrenceSchedule, timezone: string, from: Date, to: Date) {
    const runs: Array<{ start: string; night: number | null; from: Date }> = [];
    let previous: string | null = null;
    for (let t = from.getTime(); t <= to.getTime(); t += 10 * MINUTE) {
      const now = new Date(t);
      const result = computeOccurrence(sched, timezone, now);
      const current = result.inWindow ? result.windowStart.toISOString() : null;
      if (current && current !== previous) runs.push({ start: current, night: result.nightIndex, from: now });
      previous = current;
    }
    return runs;
  }

  it('a window starting in the spring-forward gap opens at a valid instant, once', () => {
    const runs = inWindowRuns(gapNight, NY, new Date('2027-03-14T04:00:00.000Z'), new Date('2027-03-14T16:00:00.000Z'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.night).toBe(0);
    // 02:30 does not exist: the shift-forward rule gives 03:30 EDT, 07:30 UTC.
    expect(runs[0]!.start).toBe('2027-03-14T07:30:00.000Z');
  });

  it('an hour-long window wholly inside the gap keeps its hour instead of vanishing', () => {
    const short = schedule({ weekOfMonth: 'second', dayOfWeek: 'sun', windowStart: '02:00', windowHours: 1 });
    const result = computeOccurrence(short, NY, new Date('2027-03-14T07:10:00.000Z'));
    expect(result.windowStart).toEqual(new Date('2027-03-14T07:00:00.000Z'));
    expect(result.windowEnd).toEqual(new Date('2027-03-14T08:00:00.000Z'));
    expect(result.inWindow).toBe(true);
  });

  it('a window spanning the gap keeps its wall-clock close, so it never reaches further into the morning', () => {
    // 01:00 to 05:00 New York, with the 02:00 hour missing: 3 real hours, closing at 05:00 EDT.
    const spanning = schedule({ weekOfMonth: 'second', dayOfWeek: 'sun' });
    const result = computeOccurrence(spanning, NY, new Date('2027-03-14T06:30:00.000Z'));
    expect(result.windowStart).toEqual(new Date('2027-03-14T06:00:00.000Z'));
    expect(result.windowEnd).toEqual(new Date('2027-03-14T09:00:00.000Z'));
    expect(result.windowMinutes).toBe(180);
  });

  it('the autumn repeated hour fires once', () => {
    // 2027-11-07 is the first Sunday of November: New York repeats 01:00 to 02:00.
    const fold = schedule({ weekOfMonth: 'first', dayOfWeek: 'sun', windowStart: '01:30', windowHours: 1 });
    const runs = inWindowRuns(fold, NY, new Date('2027-11-07T03:00:00.000Z'), new Date('2027-11-07T12:00:00.000Z'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.night).toBe(0);
    expect(runs[0]!.start).toBe('2027-11-07T05:30:00.000Z'); // the first 01:30, EDT
  });

  it('nights stay at the same wall-clock time either side of a change', () => {
    // Anchor 2027-03-10 (second Wednesday), catch-up night 4 is the Sunday of the change... night 5 is after it.
    const before = computeOccurrence(schedule({ weekOfMonth: 'second' }), NY, new Date('2027-03-11T06:30:00.000Z'));
    const after = computeOccurrence(schedule({ weekOfMonth: 'second' }), NY, new Date('2027-03-15T05:30:00.000Z'));
    expect(before.nightIndex).toBe(1);
    expect(before.windowStart).toEqual(new Date('2027-03-11T06:00:00.000Z')); // 01:00 EST
    expect(after.nightIndex).toBe(5);
    expect(after.windowStart).toEqual(new Date('2027-03-15T05:00:00.000Z')); // 01:00 EDT
  });
});

describe('computeOccurrence: catch-up', () => {
  it('numbers the catch-up nights and stops after the last', () => {
    const sched = schedule({ catchUpNights: 2 });
    expect(computeOccurrence(sched, 'UTC', new Date('2027-01-21T02:00:00.000Z')).nightIndex).toBe(1);
    const last = computeOccurrence(sched, 'UTC', new Date('2027-01-22T02:00:00.000Z'));
    expect(last.nightIndex).toBe(2);
    expect(last.isPastLastNight).toBe(false);

    const after = computeOccurrence(sched, 'UTC', new Date('2027-01-22T05:00:00.000Z'));
    expect(after.nightIndex).toBeNull();
    expect(after.inWindow).toBe(false);
    expect(after.isPastLastNight).toBe(true);
    expect(after.occurrenceKey).toBe('2027-01');
  });

  it('between nights, the window is the next night and it is not past the last', () => {
    const result = computeOccurrence(schedule(), 'UTC', new Date('2027-01-20T12:00:00.000Z'));
    expect(result.nightIndex).toBeNull();
    expect(result.inWindow).toBe(false);
    expect(result.isPastLastNight).toBe(false);
    expect(result.windowStart).toEqual(new Date('2027-01-21T01:00:00.000Z'));
  });

  it('zero catch-up nights is the anchor night alone', () => {
    const sched = schedule({ catchUpNights: 0 });
    expect(computeOccurrence(sched, 'UTC', new Date('2027-01-20T02:00:00.000Z')).nightIndex).toBe(0);
    const next = computeOccurrence(sched, 'UTC', new Date('2027-01-21T02:00:00.000Z'));
    expect(next.inWindow).toBe(false);
    expect(next.isPastLastNight).toBe(true);
  });

  it('a catch-up night crossing into the next month keeps the previous key', () => {
    // Fourth Wednesday of January 2027 is the 27th; night 7 is 3 February.
    const sched = schedule({ weekOfMonth: 'fourth' });
    const result = computeOccurrence(sched, 'UTC', new Date('2027-02-03T02:00:00.000Z'));
    expect(result.occurrenceKey).toBe('2027-01');
    expect(result.nightIndex).toBe(7);
    expect(result.inWindow).toBe(true);
  });

  it('the next occurrence does not start while catch-up runs, and starts at its own anchor', () => {
    const sched = schedule({ weekOfMonth: 'fourth', catchUpNights: 14 });
    // Night 14 of January's is 10 February; February's anchor is the 24th.
    const lastNight = computeOccurrence(sched, 'UTC', new Date('2027-02-10T02:00:00.000Z'));
    expect(lastNight.occurrenceKey).toBe('2027-01');
    expect(lastNight.nightIndex).toBe(14);

    const gap = computeOccurrence(sched, 'UTC', new Date('2027-02-23T23:00:00.000Z'));
    expect(gap.occurrenceKey).toBe('2027-01');
    expect(gap.isPastLastNight).toBe(true);

    const next = computeOccurrence(sched, 'UTC', new Date('2027-02-24T01:00:00.000Z'));
    expect(next.occurrenceKey).toBe('2027-02');
    expect(next.nightIndex).toBe(0);
    expect(next.isPastLastNight).toBe(false);
  });

  it('January looks back to December across the year', () => {
    const result = computeOccurrence(schedule(), 'UTC', new Date('2027-01-05T02:00:00.000Z'));
    expect(result.occurrenceKey).toBe('2026-12');
    expect(result.isPastLastNight).toBe(true);
  });

  it('an invalid timezone reads as UTC rather than failing the tick', () => {
    const result = computeOccurrence(schedule(), 'Not/AZone', new Date('2027-01-20T02:00:00.000Z'));
    expect(result.windowStart).toEqual(new Date('2027-01-20T01:00:00.000Z'));
  });
});

describe('nightlyWindow: any night, for reboots', () => {
  it('returns the window now is inside, or the next one', () => {
    const sched = schedule();
    // 10 March is no night of any occurrence: the third Wednesday is the 17th.
    const inside = nightlyWindow(sched, 'UTC', new Date('2027-03-10T02:00:00.000Z'));
    expect(inside.windowStart).toEqual(new Date('2027-03-10T01:00:00.000Z'));
    expect(inside.windowEnd).toEqual(new Date('2027-03-10T05:00:00.000Z'));

    const after = nightlyWindow(sched, 'UTC', new Date('2027-03-10T12:00:00.000Z'));
    expect(after.windowStart).toEqual(new Date('2027-03-11T01:00:00.000Z'));
  });

  it('a window crossing midnight is still tonight after midnight', () => {
    const late = schedule({ windowStart: '23:00', windowHours: 4 });
    const result = nightlyWindow(late, 'UTC', new Date('2027-03-11T01:00:00.000Z'));
    expect(result.windowStart).toEqual(new Date('2027-03-10T23:00:00.000Z'));
    expect(result.windowEnd).toEqual(new Date('2027-03-11T03:00:00.000Z'));
  });
});

describe('stableOffsetMinutes', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('is stable for a device', () => {
    for (const id of ids) expect(stableOffsetMinutes(id, 240)).toBe(stableOffsetMinutes(id, 240));
  });

  it('stays inside the first hour of a long window', () => {
    for (const id of ids) {
      const offset = stableOffsetMinutes(id, 480);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(60);
      expect(Number.isInteger(offset)).toBe(true);
    }
  });

  it('stays inside the first half of a 1-hour window', () => {
    for (const id of ids) {
      const offset = stableOffsetMinutes(id, 60);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(30);
    }
  });

  it('every device is seen by at least two ticks before its notAfter, whatever the tick phase', () => {
    // The worker ticks every 10 minutes on a fixed phase. An offset in the last tick
    // before notAfter would be seen by none, every night.
    for (const windowMinutes of [60, 90, 120, 180, 240, 480]) {
      const start = Date.UTC(2027, 0, 20, 1, 0);
      const notAfter = notAfterFor(new Date(start + windowMinutes * MINUTE), windowMinutes).getTime();
      for (let phase = 0; phase < 10; phase += 1) {
        for (const id of ids) {
          const startsAt = start + stableOffsetMinutes(id, windowMinutes) * MINUTE;
          let ticks = 0;
          for (let t = start + phase * MINUTE; t < notAfter; t += 10 * MINUTE) if (t >= startsAt) ticks += 1;
          expect(ticks, `${windowMinutes} min window, phase ${phase}, ${id}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('a 3-hour window or longer still spreads over its whole first hour', () => {
    expect(Math.max(...ids.map((id) => stableOffsetMinutes(id, 180)))).toBeGreaterThan(50);
  });

  it('spreads devices out', () => {
    expect(new Set(ids.map((id) => stableOffsetMinutes(id, 240))).size).toBeGreaterThan(20);
  });

  it('a degenerate window has no offset', () => {
    expect(stableOffsetMinutes(ids[0]!, 0)).toBe(0);
    expect(stableOffsetMinutes(ids[0]!, 1)).toBe(0);
  });
});

describe('notAfterFor', () => {
  const end = new Date('2027-01-20T05:00:00.000Z');

  it('stops an hour before a long window closes', () => {
    expect(notAfterFor(end, 240)).toEqual(new Date('2027-01-20T04:00:00.000Z'));
  });

  it('stops at the middle of a 1-hour window', () => {
    expect(notAfterFor(end, 60)).toEqual(new Date('2027-01-20T04:30:00.000Z'));
  });

  it('is always after the latest offset, so no device is offset past its own deadline', () => {
    for (const windowMinutes of [60, 90, 120, 180, 240, 480]) {
      const start = end.getTime() - windowMinutes * MINUTE;
      const latest = start + (stableOffsetBound(windowMinutes) - 1) * MINUTE;
      expect(notAfterFor(end, windowMinutes).getTime()).toBeGreaterThan(latest);
    }
  });

  function stableOffsetBound(windowMinutes: number): number {
    return Math.min(60, windowMinutes / 2);
  }
});

describe('attempts', () => {
  it('allows three per occurrence', () => {
    expect(OEM_MAX_ATTEMPTS_PER_OCCURRENCE).toBe(3);
  });

  it('battery and a pending reboot consume none', () => {
    expect(ATTEMPT_CONSUMING_OUTCOMES.has('blocked_on_battery')).toBe(false);
    expect(ATTEMPT_CONSUMING_OUTCOMES.has('blocked_reboot_pending')).toBe(false);
    expect(consumesAttempt('blocked_on_battery', null)).toBe(false);
    expect(consumesAttempt('blocked_reboot_pending', null)).toBe(false);
  });

  it('an interrupted run consumes one', () => {
    expect(consumesAttempt('interrupted', null)).toBe(true);
  });

  it('every other finished or failed outcome consumes one', () => {
    for (const outcome of ['success', 'success_reboot_required', 'no_updates', 'partial', 'failed', 'not_supported', 'tool_unavailable', 'blocked_no_recovery_key'] as const) {
      expect(consumesAttempt(outcome, null), outcome).toBe(true);
    }
  });

  it('retry_later refused before the tool started consumes none', () => {
    for (const code of ['not_after_passed', 'run_in_flight', 'preflight_failed', 'flash_in_progress']) {
      expect(consumesAttempt('retry_later', code), code).toBe(false);
    }
  });

  it('retry_later from a tool that ran consumes one', () => {
    expect(consumesAttempt('retry_later', null)).toBe(true);
    expect(consumesAttempt('retry_later', 'wu_search_failed')).toBe(true);
  });
});

describe('occurrenceBoundaries: what the policy side stores (#11242)', () => {
  /** Every `stepMinutes` from `from` up to (not including) `until`. */
  function* instants(from: Date, until: Date, stepMinutes: number): Generator<Date> {
    for (let t = from.getTime(); t < until.getTime(); t += stepMinutes * MINUTE) yield new Date(t);
  }

  /** The stored boundaries answer exactly as the live rule does, at every sampled instant until the rollover. */
  function agreesUntilRollover(sched: OemOccurrenceSchedule, zone: string, computedAt: Date, stepMinutes: number) {
    const bounds = occurrenceBoundaries(sched, zone, computedAt);
    expect(bounds.occurrenceKey).toBe(computeOccurrence(sched, zone, computedAt).occurrenceKey);
    // Each stored instant, and a millisecond either side of it.
    const probes = [bounds.lastNightStart, bounds.pastLastNightAt]
      .flatMap((edge) => [-1, 0, 1].map((ms) => new Date(edge.getTime() + ms)))
      .filter((t) => t >= computedAt && t < bounds.refreshAfter);
    for (const t of [...probes, ...instants(computedAt, bounds.refreshAfter, stepMinutes)]) {
      const live = computeOccurrence(sched, zone, t);
      expect(live.occurrenceKey, t.toISOString()).toBe(bounds.occurrenceKey);
      expect(live.isPastLastNight, t.toISOString()).toBe(t.getTime() >= bounds.pastLastNightAt.getTime());
      if (live.isPastLastNight) expect(live.windowStart.getTime(), t.toISOString()).toBe(bounds.lastNightStart.getTime());
    }
    return bounds;
  }

  it('occurrenceBoundaries agrees with computeOccurrence every 5 minutes of a sampled month, America/New_York across DST end', () => {
    // November 2026's first Sunday is the DST end itself (2026-11-01), with catch-up
    // nights after it, so windows on both sides of the change are in range. Every window
    // edge here falls on a whole 5 minutes, and the probes cover each stored instant ±1 ms.
    const sched = schedule({ weekOfMonth: 'first', dayOfWeek: 'sun', windowStart: '01:30', windowHours: 2, catchUpNights: 3 });
    const bounds = agreesUntilRollover(sched, NY, new Date('2026-10-31T00:00:00.000Z'), 5);
    expect(bounds.occurrenceKey).toBe('2026-10');
    // November's anchor window opens at 01:30 EDT, before the clocks go back.
    expect(bounds.refreshAfter.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const next = agreesUntilRollover(sched, NY, bounds.refreshAfter, 5);
    expect(next.occurrenceKey).toBe('2026-11');
    // Night 3 is 2026-11-04 01:30 EST, for 2 hours.
    expect(next.lastNightStart.toISOString()).toBe('2026-11-04T06:30:00.000Z');
    expect(next.pastLastNightAt.toISOString()).toBe('2026-11-04T08:30:00.000Z');
  });

  it('refreshAfter is the instant the occurrence key changes', () => {
    const cases: Array<[string, OemOccurrenceSchedule, string]> = [
      ['UTC', schedule(), '2027-01-01T00:00:00.000Z'],
      [NY, schedule({ weekOfMonth: 'second', dayOfWeek: 'sun', windowStart: '02:30', windowHours: 3, catchUpNights: 2 }), '2027-03-01T00:00:00.000Z'],
      ['Australia/Sydney', schedule({ weekOfMonth: 'last', dayOfWeek: 'fri', windowStart: '23:00', windowHours: 4, catchUpNights: 7 }), '2027-03-20T00:00:00.000Z'],
    ];
    for (const [zone, sched, from] of cases) {
      let at = new Date(from);
      for (let month = 0; month < 14; month += 1) {
        const bounds = occurrenceBoundaries(sched, zone, at);
        const justBefore = new Date(bounds.refreshAfter.getTime() - 1);
        expect(computeOccurrence(sched, zone, justBefore).occurrenceKey, `${zone} ${justBefore.toISOString()}`).toBe(bounds.occurrenceKey);
        const after = computeOccurrence(sched, zone, bounds.refreshAfter);
        expect(after.occurrenceKey, `${zone} ${bounds.refreshAfter.toISOString()}`).not.toBe(bounds.occurrenceKey);
        // The next occurrence starts on its anchor night, inside its first window.
        expect(after.nightIndex).toBe(0);
        expect(bounds.pastLastNightAt.getTime()).toBeLessThan(bounds.refreshAfter.getTime());
        at = bounds.refreshAfter;
      }
    }
  });

  it('agrees hour by hour over a year in a zone with a half-hour DST shift', () => {
    const sched = schedule({ weekOfMonth: 'first', dayOfWeek: 'sun', windowStart: '02:00', windowHours: 1, catchUpNights: 1 });
    let at = new Date('2026-12-15T00:00:00.000Z');
    for (let month = 0; month < 13; month += 1) {
      at = agreesUntilRollover(sched, 'Australia/Lord_Howe', at, 60).refreshAfter;
    }
  });
});
