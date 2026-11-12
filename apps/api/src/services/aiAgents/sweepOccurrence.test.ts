/**
 * Occurrence math for the fixed-tick sweeper (Phase 2 wave P2-2, task 9).
 *
 * Pure — no DB, no clock. Every case below pins a real DST edge in
 * Europe/Berlin, because the whole reason this module exists rather than a
 * bare `isCronDue(now)` check is that a 5-minute tick must fire a
 * once-a-day schedule exactly once even when the local wall clock repeats or
 * skips an hour.
 */
import { describe, expect, it, vi } from 'vitest';

const { cronDueCalls } = vi.hoisted(() => ({ cronDueCalls: { n: 0 } }));
vi.mock('../cronDue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cronDue')>();
  return {
    ...real,
    isCronDue: (...args: Parameters<typeof real.isCronDue>) => {
      cronDueCalls.n += 1;
      return real.isCronDue(...args);
    },
  };
});

import {
  CronOccurrenceCache,
  SWEEP_OCCURRENCE_LOOKBACK_MINUTES,
  latestCronOccurrence,
  occurrenceKey,
} from './sweepOccurrence';

describe('latestCronOccurrence', () => {
  it('returns the most recent matching minute in the zone', () => {
    const r = latestCronOccurrence('0 6 * * *', 'Europe/Berlin', new Date('2026-08-29T05:07:00Z'));
    expect(r?.key).toBe('2026-08-29T06:00@Europe/Berlin');
    expect(r?.at.toISOString()).toBe('2026-08-29T04:00:00.000Z');
  });

  it('returns null when nothing matched inside the lookback', () => {
    // 2026-08-29 is a Saturday; the next Monday 06:00 is days away.
    expect(latestCronOccurrence('0 6 * * 1', 'UTC', new Date('2026-08-29T05:07:00Z'), 60)).toBeNull();
  });

  it('fall-back DST: the repeated 02:30 local hour yields ONE key', () => {
    const a = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T00:45:00Z')); // 02:45 CEST (first pass)
    const b = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-10-25T01:45:00Z')); // 02:45 CET (second pass)
    expect(a?.key).toBe('2026-10-25T02:30@Europe/Berlin');
    expect(b?.key).toBe(a?.key);
    // The two passes are genuinely different UTC instants — it is the KEY
    // that collapses them, which is what makes the tick's
    // `key === lastOccurrenceKey` skip fire exactly once.
    expect(a?.at.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(b?.at.toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('spring-forward: the skipped 02:30 local hour produces NO occurrence in the lookback', () => {
    // 2026-03-29, Europe/Berlin: 02:00 CET jumps straight to 03:00 CEST, so
    // 02:30 local never exists. The previous day's 02:30 (2026-03-28T01:30Z)
    // is 30.5 h behind `now` and therefore outside the 24 h lookback — the
    // occurrence is documented as skipped, not silently backdated.
    const r = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-03-29T08:00:00Z'));
    expect(r).toBeNull();
  });

  it('spring-forward: a wider lookback still finds only the PREVIOUS day, never the skipped minute', () => {
    const r = latestCronOccurrence('30 2 * * *', 'Europe/Berlin', new Date('2026-03-29T08:00:00Z'), 48 * 60);
    expect(r?.key).toBe('2026-03-28T02:30@Europe/Berlin');
    expect(r?.at.toISOString()).toBe('2026-03-28T01:30:00.000Z');
  });

  it('floors `now` to the minute — an occurrence in the current minute counts', () => {
    const r = latestCronOccurrence('0 6 * * *', 'Europe/Berlin', new Date('2026-08-29T04:00:59.999Z'));
    expect(r?.at.toISOString()).toBe('2026-08-29T04:00:00.000Z');
  });

  it('the lookback default is 24 hours', () => {
    expect(SWEEP_OCCURRENCE_LOOKBACK_MINUTES).toBe(24 * 60);
  });

  it('a 6-field (seconds-leading) cron never fires — the evaluator is strictly 5-field', () => {
    expect(latestCronOccurrence('0 0 6 * * *', 'UTC', new Date('2026-08-29T05:07:00Z'))).toBeNull();
  });
});

describe('occurrenceKey', () => {
  it('uses local wall clock', () => {
    expect(occurrenceKey(new Date('2026-08-29T04:00:00Z'), 'Europe/Berlin')).toBe('2026-08-29T06:00@Europe/Berlin');
  });

  it('zero-pads every component', () => {
    expect(occurrenceKey(new Date('2026-01-02T03:04:00Z'), 'UTC')).toBe('2026-01-02T03:04@UTC');
  });
});

describe('CronOccurrenceCache', () => {
  const MINUTE = 60_000;

  it('answers exactly what latestCronOccurrence answers, for ticks moving forward, back and far', () => {
    const schedules: Array<[string, string]> = [
      ['30 2 * * *', 'Europe/Berlin'],
      ['0 6 * * 1', 'UTC'],
      ['*/7 * * * *', 'America/New_York'],
      ['0 0 29 2 *', 'UTC'],
      ['15 3 * * 0', 'Australia/Lord_Howe'],
    ];
    const cache = new CronOccurrenceCache();
    const random = (seed: number) => () => {
      // mulberry32: 32-bit integer steps (Math.imul), so the sequence does not
      // collapse the way a float LCG does.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    const next = random(0x5eed);
    // Around the 2026-10-25 Berlin fall-back hour.
    let at = Date.parse('2026-10-24T20:00:00Z');
    const steps = new Set<number>();
    for (let i = 0; i < 150; i += 1) {
      const step = next() % 10;
      if (step < 6) at += (1 + (next() % 5)) * MINUTE; // a normal tick or a few late
      else if (step < 8) at += (next() % 200) * 1_000; // within the same minute or two
      else if (step < 9) at -= (next() % 120) * MINUTE; // the clock steps back
      else at += (next() % 3000) * MINUTE; // a long outage, past the lookback
      const now = new Date(at);
      steps.add(at);
      cache.beginPass();
      for (const [cron, zone] of schedules) {
        const want = latestCronOccurrence(cron, zone, now);
        const got = cache.latest(cron, zone, now);
        expect({ at: now.toISOString(), cron, got: got && { at: got.at.toISOString(), key: got.key } })
          .toEqual({ at: now.toISOString(), cron, got: want && { at: want.at.toISOString(), key: want.key } });
      }
      cache.endPass();
    }
    expect(steps.size).toBeGreaterThan(120);
  }, 60_000);

  it('lets a remembered occurrence age out of the window', () => {
    const cache = new CronOccurrenceCache();
    // 2026-10-26 is a Monday. Hourly ticks for two days: the 06:00 Monday
    // occurrence is the answer until a tick is more than 24 h past it.
    for (let at = Date.parse('2026-10-26T05:30:00Z'); at <= Date.parse('2026-10-28T08:30:00Z'); at += 60 * MINUTE) {
      const now = new Date(at);
      cache.beginPass();
      const got = cache.latest('0 6 * * 1', 'UTC', now);
      cache.endPass();
      expect([now.toISOString(), got?.key ?? null]).toEqual([now.toISOString(), latestCronOccurrence('0 6 * * 1', 'UTC', now)?.key ?? null]);
    }
  });

  it('evaluates only the minutes since the previous answer', () => {
    const cache = new CronOccurrenceCache();
    const start = Date.parse('2026-10-25T10:00:20Z');
    cronDueCalls.n = 0;
    cache.beginPass();
    expect(cache.latest('0 0 29 2 *', 'UTC', new Date(start))).toBeNull();
    cache.endPass();
    expect(cronDueCalls.n).toBe(SWEEP_OCCURRENCE_LOOKBACK_MINUTES + 1);

    cronDueCalls.n = 0;
    cache.beginPass();
    expect(cache.latest('0 0 29 2 *', 'UTC', new Date(start + MINUTE))).toBeNull();
    expect(cache.latest('0 0 29 2 *', 'UTC', new Date(start + MINUTE))).toBeNull();
    cache.endPass();
    expect(cronDueCalls.n).toBe(1);
  });

  it('forgets schedules a pass did not ask about', () => {
    const cache = new CronOccurrenceCache();
    const now = new Date('2026-10-25T10:00:20Z');
    cache.beginPass();
    cache.latest('0 * * * *', 'UTC', now);
    cache.latest('5 * * * *', 'UTC', now);
    cache.endPass();
    expect(cache.size).toBe(2);
    cache.beginPass();
    cache.latest('0 * * * *', 'UTC', now);
    cache.endPass();
    expect(cache.size).toBe(1);
  });

  it('does not remember a schedule that cannot be evaluated', () => {
    const cache = new CronOccurrenceCache();
    cache.beginPass();
    expect(() => cache.latest('0 * * * *', 'Not/AZone', new Date('2026-10-25T10:00:20Z'))).toThrow();
    cache.endPass();
    expect(cache.size).toBe(0);
  });
});
