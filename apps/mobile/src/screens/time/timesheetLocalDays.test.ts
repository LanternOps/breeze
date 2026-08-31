// The whole point of this suite is the local/UTC seam, so the zone must be
// pinned. It is pinned in vitest.config.ts, NOT here: assigning process.env.TZ
// inside a test file does not take effect under the threads pool (Node does not
// re-read TZ in a worker), which made this suite pass under the default forks
// pool and fail on the documented `--pool=threads` invocation. The first
// describe below asserts the pin actually applied.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/api', () => ({ coreRequest: vi.fn() }));

import { buildLocalWeek, localDayKey, neighbourWeekOffsets } from './timesheetLocalDays';
import { daysOfWeek } from './timesheetWeek';
import type { TimeEntry } from '../../services/timeEntries';

function entry(overrides: Partial<TimeEntry> & Pick<TimeEntry, 'id' | 'startedAt'>): TimeEntry {
  return {
    ticketId: 'k1',
    endedAt: null,
    durationMinutes: 60,
    isBillable: true,
    billingStatus: 'not_billed',
    isApproved: false,
    description: null,
    ...overrides,
  };
}

describe('the pinned zone actually took effect', () => {
  it('is UTC-4 in August, so the assertions below are not vacuous', () => {
    expect(new Date('2026-08-30T12:00:00Z').getTimezoneOffset()).toBe(240);
  });
});

describe('localDayKey', () => {
  it('files a Sunday-evening callout under Sunday, not the UTC Monday', () => {
    // 20:00 Sunday in New York is already 00:00 Monday in UTC. The server keys
    // its day buckets off toISOString(), so trusting them shows a Sunday
    // evening as Monday work.
    expect(localDayKey('2026-08-31T00:00:00.000Z')).toBe('2026-08-30');
  });

  it('returns null for an unparseable timestamp rather than a fabricated day', () => {
    expect(localDayKey('not a date')).toBeNull();
  });
});

/**
 * Stand-in local calendars, so the DST behaviour is deterministic rather than
 * dependent on whatever zone the runner happens to be in. Offsets are in
 * minutes AHEAD of UTC (the opposite sign to `getTimezoneOffset`).
 */
function zone(offsetMinutesFor: (dateOnly: string) => number) {
  return (dateOnly: string): number =>
    Date.parse(`${dateOnly}T00:00:00.000Z`) - offsetMinutesFor(dateOnly) * 60_000;
}

/** Europe/London: UTC+1 in summer, UTC+0 in winter. */
const london = zone((dateOnly) => (dateOnly >= '2026-03-29' && dateOnly < '2026-10-25' ? 60 : 0));
/** America/New_York: UTC-4 in summer, UTC-5 in winter. */
const newYork = zone((dateOnly) => (dateOnly >= '2026-03-08' && dateOnly < '2026-11-01' ? -240 : -300));

describe('neighbourWeekOffsets', () => {
  it('asks for the NEXT server week west of Greenwich', () => {
    // Local late-Sunday work lands in the following UTC week, which the
    // requested week's window ([weekStartUTC, +7d)) excludes entirely — the
    // entry is missing from both the rows and the weekly total.
    expect(neighbourWeekOffsets('2026-08-24', newYork)).toEqual([1]);
  });

  it('asks for the PREVIOUS server week east of Greenwich', () => {
    // Local early-Monday work sits in the previous UTC week.
    expect(neighbourWeekOffsets('2026-08-24', london)).toEqual([-1]);
  });

  it('asks for nothing extra where the local week aligns with UTC', () => {
    // A London week in January: the two calendars agree exactly.
    expect(neighbourWeekOffsets('2026-01-05', london)).toEqual([]);
  });

  it('answers for the DISPLAYED week, not for today', () => {
    // The defect: the offset was read from `new Date().getTimezoneOffset()`, so
    // paging from a January week to a July one in London kept answering "no
    // neighbour" and the July week silently lost its Sunday-23:00 boundary
    // entries — from the rows AND the total. Two weeks, one runner, different
    // answers is exactly what a today-derived offset cannot produce.
    expect(neighbourWeekOffsets('2026-01-05', london)).toEqual([]);
    expect(neighbourWeekOffsets('2026-07-06', london)).toEqual([-1]);
  });

  it('handles the week the clocks go back', () => {
    // 2026-10-25 in London and 2026-11-01 in New York. The week straddling the
    // change has one boundary in each offset, so a single "today" answer is
    // wrong for one of its two ends by construction.
    expect(neighbourWeekOffsets('2026-10-19', london)).toEqual([-1]);
    expect(neighbourWeekOffsets('2026-10-26', newYork)).toEqual([1]);
  });

  it('agrees with the real local calendar in the pinned zone', () => {
    // Ties the injectable resolver to the actual one, so the stand-ins above
    // cannot drift into testing only themselves.
    expect(neighbourWeekOffsets('2026-08-24')).toEqual([1]);
  });
});

describe('buildLocalWeek', () => {
  const days = daysOfWeek('2026-08-24');

  it('keeps a local Sunday-evening entry in the local week it belongs to', () => {
    const view = buildLocalWeek([entry({ id: 'a', startedAt: '2026-08-31T00:00:00.000Z' })], days);

    expect(view.byDay.get('2026-08-30')?.map((e) => e.id)).toEqual(['a']);
    expect(view.byDay.get('2026-08-31')).toBeUndefined();
    expect(view.totals.totalMinutes).toBe(60);
  });

  it('drops the previous local week, which the server window includes west of UTC', () => {
    // 2026-08-23 20:00 New York = 2026-08-24T00:00Z, inside the requested
    // server window but outside the technician's local week.
    const view = buildLocalWeek([entry({ id: 'old', startedAt: '2026-08-24T00:00:00.000Z' })], days);

    expect(view.totals.totalMinutes).toBe(0);
    expect([...view.byDay.keys()]).toEqual([]);
  });

  it('sums day and week totals from the entries actually shown', () => {
    const view = buildLocalWeek(
      [
        entry({ id: 'a', startedAt: '2026-08-24T14:00:00.000Z', durationMinutes: 30 }),
        entry({ id: 'b', startedAt: '2026-08-24T18:00:00.000Z', durationMinutes: 45, isBillable: false }),
        entry({ id: 'c', startedAt: '2026-08-26T14:00:00.000Z', durationMinutes: 15 }),
      ],
      days
    );

    expect(view.dayTotals.get('2026-08-24')).toBe(75);
    expect(view.dayTotals.get('2026-08-26')).toBe(15);
    expect(view.totals).toEqual({ totalMinutes: 90, billableMinutes: 45 });
  });

  it('counts a still-running entry as zero rather than NaN', () => {
    const view = buildLocalWeek(
      [entry({ id: 'a', startedAt: '2026-08-24T14:00:00.000Z', durationMinutes: null })],
      days
    );
    expect(view.totals.totalMinutes).toBe(0);
    expect(view.byDay.get('2026-08-24')).toHaveLength(1);
  });

  it('de-duplicates an entry returned by both the week and its neighbour', () => {
    // The two fetches overlap by design; counting the overlap twice would
    // inflate the weekly total.
    const shared = entry({ id: 'a', startedAt: '2026-08-24T14:00:00.000Z', durationMinutes: 30 });
    const view = buildLocalWeek([shared, { ...shared }], days);

    expect(view.byDay.get('2026-08-24')).toHaveLength(1);
    expect(view.totals.totalMinutes).toBe(30);
  });

  it('orders each day by start time so the column reads chronologically', () => {
    const view = buildLocalWeek(
      [
        entry({ id: 'late', startedAt: '2026-08-24T18:00:00.000Z' }),
        entry({ id: 'early', startedAt: '2026-08-24T13:00:00.000Z' }),
      ],
      days
    );
    expect(view.byDay.get('2026-08-24')?.map((e) => e.id)).toEqual(['early', 'late']);
  });
});
