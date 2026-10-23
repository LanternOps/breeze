import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  validateRevision,
  weeklyOpenMinutes,
  type CalendarInterval,
  type CalendarRevision,
} from './businessTime';

// #8973 spec §4.3 / §4.4 — the one SLA calculator. Weekday 0 = Sunday.

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

function weekdays(startMinute: number, endMinute: number, days: number[] = [1, 2, 3, 4, 5]): CalendarInterval[] {
  return days.map((weekday) => ({ weekday: weekday as CalendarInterval['weekday'], startMinute, endMinute }));
}

const londonOffice: CalendarRevision = { timezone: 'Europe/London', intervals: weekdays(9 * 60, 17 * 60) };
const londonSplit: CalendarRevision = {
  timezone: 'Europe/London',
  intervals: [...weekdays(8 * 60, 12 * 60), ...weekdays(13 * 60, 17 * 60)],
};

describe('addBusinessMinutes with no calendar (24x7)', () => {
  it('is plain minute addition', () => {
    const t = at('2026-03-08T06:59:30.250Z');
    expect(addBusinessMinutes(null, [], t, 45).getTime()).toBe(t.getTime() + 45 * MIN);
    expect(addBusinessMinutes(null, [], t, 0).getTime()).toBe(t.getTime());
  });

  it('keeps the 0.8 fraction at second precision', () => {
    const t = at('2026-01-01T00:00:00Z');
    expect(addBusinessMinutes(null, [], t, 0.8 * 45).getTime()).toBe(t.getTime() + 36 * MIN);
    // 0.8 * 7 = 5.6 min = 336 s (the float product is 5.6000000000000005).
    expect(addBusinessMinutes(null, [], t, 0.8 * 7).getTime()).toBe(t.getTime() + 336_000);
  });

  it('businessMinutesBetween is wall-clock minutes', () => {
    expect(businessMinutesBetween(null, [], at('2026-01-01T00:00:00Z'), at('2026-01-01T01:30:00Z'))).toBe(90);
    expect(businessMinutesBetween(null, [], at('2026-01-01T01:00:00Z'), at('2026-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('addBusinessMinutes on a Mon–Fri 09:00–17:00 Europe/London calendar', () => {
  it('Fri 16:00 + 120 → Mon 10:00', () => {
    // 2026-01-09 is a Friday; London is on GMT (UTC+0) in January.
    expect(addBusinessMinutes(londonOffice, [], at('2026-01-09T16:00:00Z'), 120).toISOString())
      .toBe('2026-01-12T10:00:00.000Z');
  });

  it('a weekend start counts from Mon 09:00', () => {
    expect(addBusinessMinutes(londonOffice, [], at('2026-01-10T12:00:00Z'), 30).toISOString())
      .toBe('2026-01-12T09:30:00.000Z');
  });

  it('a target that ends exactly at close lands on close', () => {
    expect(addBusinessMinutes(londonOffice, [], at('2026-01-09T16:00:00Z'), 60).toISOString())
      .toBe('2026-01-09T17:00:00.000Z');
  });

  it('summer time shifts the UTC instant (BST = UTC+1)', () => {
    // Fri 2026-07-10 16:00 BST = 15:00Z; + 120 → Mon 10:00 BST = 09:00Z.
    expect(addBusinessMinutes(londonOffice, [], at('2026-07-10T15:00:00Z'), 120).toISOString())
      .toBe('2026-07-13T09:00:00.000Z');
  });
});

describe('split shifts and holidays', () => {
  it('skips the lunch gap', () => {
    // Mon 2026-01-05 11:30 + 60 → 12:00 (30) + 13:00..13:30 (30).
    expect(addBusinessMinutes(londonSplit, [], at('2026-01-05T11:30:00Z'), 60).toISOString())
      .toBe('2026-01-05T13:30:00.000Z');
  });

  it('skips a Monday holiday', () => {
    // Fri 2026-01-09 16:30 + 60: 30 on Friday, Mon 12th is a holiday → Tue 08:30.
    expect(addBusinessMinutes(londonSplit, ['2026-01-12'], at('2026-01-09T16:30:00Z'), 60).toISOString())
      .toBe('2026-01-13T08:30:00.000Z');
  });

  it('a holiday on the Friday of the final (walked) week', () => {
    // Mon 5th 08:00 + 2 weeks (4800). Week 2 loses Fri 16th → ends Mon 19th 17:00.
    expect(addBusinessMinutes(londonSplit, ['2026-01-16'], at('2026-01-05T08:00:00Z'), 4800).toISOString())
      .toBe('2026-01-19T17:00:00.000Z');
  });

  it('a holiday on the Friday that closes a jumped week', () => {
    // Mon 5th 08:00 + 3 weeks (7200). The week holding Fri 16th is jumped whole
    // (1920 instead of 2400) → ends Mon 26th 17:00.
    expect(addBusinessMinutes(londonSplit, ['2026-01-16'], at('2026-01-05T08:00:00Z'), 7200).toISOString())
      .toBe('2026-01-26T17:00:00.000Z');
    expect(businessMinutesBetween(londonSplit, ['2026-01-16'], at('2026-01-05T08:00:00Z'), at('2026-01-26T17:00:00Z')))
      .toBe(7200);
  });

  it('ignores holidays outside the range', () => {
    const holidays = ['2025-12-25', '2026-01-16', '2026-12-25'];
    expect(businessMinutesBetween(londonOffice, holidays, at('2026-01-12T00:00:00Z'), at('2026-01-17T00:00:00Z')))
      .toBe(4 * 480);
  });
});

describe('DST transitions (Review Focus #3)', () => {
  // An interval 00:00–06:00 on the transition day counts its real elapsed
  // minutes: 300 when the clock springs forward, 420 when it falls back.
  const cases: Array<{ timezone: string; date: string; weekday: number; expected: number }> = [
    { timezone: 'America/New_York', date: '2026-03-08', weekday: 0, expected: 300 },
    { timezone: 'America/New_York', date: '2026-11-01', weekday: 0, expected: 420 },
    { timezone: 'Europe/London', date: '2026-03-29', weekday: 0, expected: 300 },
    { timezone: 'Europe/London', date: '2026-10-25', weekday: 0, expected: 420 },
    { timezone: 'Australia/Sydney', date: '2026-04-05', weekday: 0, expected: 420 },
    { timezone: 'Australia/Sydney', date: '2026-10-04', weekday: 0, expected: 300 },
  ];

  for (const { timezone, date, weekday, expected } of cases) {
    it(`${timezone} ${date}: 00:00–06:00 is ${expected} real minutes`, () => {
      const rev: CalendarRevision = { timezone, intervals: [{ weekday: weekday as 0, startMinute: 0, endMinute: 360 }] };
      const dayBefore = new Date(Date.parse(`${date}T00:00:00Z`) - 36 * 3_600_000);
      const dayAfter = new Date(Date.parse(`${date}T00:00:00Z`) + 36 * 3_600_000);
      expect(businessMinutesBetween(rev, [], dayBefore, dayAfter)).toBe(expected);
      // The interval closes at local 06:00 whatever the offset.
      const end = addBusinessMinutes(rev, [], dayBefore, expected);
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(end);
      expect(local).toBe(`${date}, 06:00`);
    });
  }

  it('week jumps across a transition still count real minutes', () => {
    // Sundays 00:00–06:00 New York, Jan 1 → Jul 1 2026: 26 Sundays, one of
    // them (Mar 8) an hour short.
    const rev: CalendarRevision = { timezone: 'America/New_York', intervals: [{ weekday: 0, startMinute: 0, endMinute: 360 }] };
    expect(businessMinutesBetween(rev, [], at('2026-01-01T12:00:00Z'), at('2026-07-01T12:00:00Z'))).toBe(26 * 360 - 60);
  });
});

describe('round-trip property', () => {
  // Deterministic LCG so a failure reproduces.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const zones = ['America/New_York', 'Europe/London', 'Australia/Sydney'];
  const calendars = zones.flatMap((timezone): CalendarRevision[] => [
    { timezone, intervals: weekdays(9 * 60, 17 * 60) },
    { timezone, intervals: [...weekdays(8 * 60, 12 * 60), ...weekdays(13 * 60, 17 * 60)] },
    { timezone, intervals: [...weekdays(0, 360, [0, 1, 2, 3, 4, 5, 6]), ...weekdays(19 * 60, 24 * 60, [6])] },
  ]);
  const holidays = ['2026-01-01', '2026-03-09', '2026-04-03', '2026-04-06', '2026-10-05', '2026-11-02', '2026-12-25'];

  it('businessMinutesBetween(s, addBusinessMinutes(s, n)) === n over 500 seeded cases', () => {
    const next = rng(8973);
    for (let i = 0; i < 500; i++) {
      const rev = calendars[Math.floor(next() * calendars.length)]!;
      const start = new Date(Date.parse('2026-01-01T00:00:00Z') + Math.floor(next() * 365 * 24 * 60) * MIN + Math.floor(next() * 60) * 1000);
      const n = Math.floor(next() * 20_000);
      const end = addBusinessMinutes(rev, holidays, start, n);
      expect(end.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(businessMinutesBetween(rev, holidays, start, end), `case ${i}: ${rev.timezone} ${start.toISOString()} + ${n}`).toBe(n);
    }
  });
});

describe('bounds', () => {
  it('525600 minutes on a 40 h/week calendar terminates, round-trips, and is fast', () => {
    const start = at('2026-01-05T09:00:00Z');
    const t0 = performance.now();
    const end = addBusinessMinutes(londonOffice, ['2026-12-25', '2027-12-24', '2028-12-25'], start, 525_600);
    const elapsed = performance.now() - t0;
    expect(businessMinutesBetween(londonOffice, ['2026-12-25', '2027-12-24', '2028-12-25'], start, end)).toBe(525_600);
    // 525600 / 2400 per week ≈ 219 weeks ≈ 4.2 years.
    expect(end.getUTCFullYear()).toBe(2030);
    expect(elapsed).toBeLessThan(50);
  });

  it('refuses a calendar with no open time instead of looping forever', () => {
    expect(() => addBusinessMinutes({ timezone: 'UTC', intervals: [] }, [], at('2026-01-01T00:00:00Z'), 10)).toThrow();
  });
});

describe('weeklyOpenMinutes', () => {
  it('sums the nominal interval lengths', () => {
    expect(weeklyOpenMinutes(londonOffice)).toBe(2400);
    expect(weeklyOpenMinutes(londonSplit)).toBe(2400);
  });
});

describe('validateRevision', () => {
  it('accepts a well-formed calendar', () => {
    expect(validateRevision(londonSplit)).toEqual({ ok: true });
    expect(validateRevision({ timezone: 'UTC', intervals: [{ weekday: 6, startMinute: 0, endMinute: 1440 }] })).toEqual({ ok: true });
  });

  it('rejects an empty calendar', () => {
    expect(validateRevision({ timezone: 'UTC', intervals: [] })).toEqual({ ok: false, code: 'NO_INTERVALS' });
  });

  it('rejects overlapping intervals on the same weekday', () => {
    expect(validateRevision({
      timezone: 'UTC',
      intervals: [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 900 }],
    })).toEqual({ ok: false, code: 'OVERLAP' });
  });

  it('allows touching intervals and the same range on different days', () => {
    expect(validateRevision({
      timezone: 'UTC',
      intervals: [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 720, endMinute: 900 }, { weekday: 2, startMinute: 540, endMinute: 720 }],
    })).toEqual({ ok: true });
  });

  it.each([
    [{ weekday: 1, startMinute: 600, endMinute: 600 }],
    [{ weekday: 1, startMinute: 700, endMinute: 600 }],
    [{ weekday: 1, startMinute: -1, endMinute: 600 }],
    [{ weekday: 1, startMinute: 0, endMinute: 1441 }],
    [{ weekday: 7, startMinute: 0, endMinute: 60 }],
    [{ weekday: 1, startMinute: 0.5, endMinute: 60 }],
  ])('rejects a bad range %o', (interval) => {
    expect(validateRevision({ timezone: 'UTC', intervals: [interval as CalendarInterval] })).toEqual({ ok: false, code: 'BAD_RANGE' });
  });

  it('rejects an unknown time zone', () => {
    expect(validateRevision({ timezone: 'Mars/Phobos', intervals: weekdays(540, 1020) })).toEqual({ ok: false, code: 'BAD_TIMEZONE' });
  });
});
