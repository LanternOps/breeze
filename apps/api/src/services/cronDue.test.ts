/**
 * `cronDue` — zoned-formatter memoisation (#4450).
 *
 * The cron FIELD maths are covered by `automationRuntime.cronExtended.test.ts`
 * (which re-exports this module); this file covers the one thing that suite
 * cannot see: `getZonedDateParts` used to build a fresh `Intl.DateTimeFormat`
 * per evaluated minute. Constructing one is expensive relative to formatting
 * with it — it resolves and validates the zone against the whole IANA database
 * — and the fixed 5-minute AI sweep tick walks a 24 h lookback ONE MINUTE AT A
 * TIME per schedule (`services/aiAgents/sweepOccurrence.ts`), so a single tick
 * over N schedules built up to 1441·N formatters and threw every one away.
 *
 * The assertions here are on the CONSTRUCTOR call count, not on timings: a
 * benchmark would be the only way to see the win otherwise, and a benchmark in
 * CI is noise. Correctness-under-sharing is asserted alongside, because a
 * cache keyed on anything other than the zone would return one zone's wall
 * clock for another — the failure mode this memoisation could introduce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCronDue, resetCronDueFormatterCache } from './cronDue';

// A fixed instant so every case below is deterministic regardless of the CI
// machine's own zone. 2026-03-02T14:30:00Z is a Monday, 09:30 in New York.
const NOW = new Date('2026-03-02T14:30:00Z');

const minutesBack = (back: number): Date => new Date(NOW.getTime() - back * 60_000);

const RealDateTimeFormat = Intl.DateTimeFormat;

let formatterBuilds = 0;

/**
 * Counting stand-in for `Intl.DateTimeFormat`.
 *
 * `vi.spyOn(Intl, 'DateTimeFormat')` cannot be used here: vitest's spy wrapper
 * is not `new`-compatible for this built-in — `new spy(...)` yields `undefined`
 * and the module under test dies on `.formatToParts is not a function`. A plain
 * function that RETURNS a real formatter IS constructible (`new f()` adopts the
 * returned object), so the count is observed without changing what the caller
 * gets back.
 */
function countingDateTimeFormat(
  ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
): Intl.DateTimeFormat {
  formatterBuilds++;
  return new RealDateTimeFormat(...args);
}

describe('isCronDue — zoned formatter memoisation (#4450)', () => {
  beforeEach(() => {
    formatterBuilds = 0;
    resetCronDueFormatterCache();
    // Only `DateTimeFormat` is overridden; every other Intl member is read
    // through, so nothing else in the process observes the stub.
    vi.stubGlobal('Intl', new Proxy(Intl, {
      get: (target, prop, receiver) =>
        prop === 'DateTimeFormat' ? countingDateTimeFormat : Reflect.get(target, prop, receiver),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCronDueFormatterCache();
  });

  it('builds ONE formatter for a walk of 60 candidate minutes in the same zone', () => {
    // This is the sweeper's inner loop, shrunk: `latestCronOccurrence` calls
    // `isCronDue` once per minute of its lookback for the SAME (cron, zone).
    for (let back = 0; back < 60; back++) {
      isCronDue('30 14 * * *', 'UTC', minutesBack(back));
    }
    expect(formatterBuilds).toBe(1);
  });

  it('reuses the same formatter across separate calls and separate expressions', () => {
    // 14:30Z is 09:30 in New York (EST — the 2026 US DST start is 8 March).
    expect(isCronDue('30 9 * * *', 'America/New_York', NOW)).toBe(true);
    expect(isCronDue('0 9 * * *', 'America/New_York', NOW)).toBe(false);
    expect(isCronDue('*/15 * * * *', 'America/New_York', NOW)).toBe(true);
    expect(formatterBuilds).toBe(1);
  });

  it('keys the cache on the ZONE — two zones interleaved still resolve their own wall clock', () => {
    // A cache that ignored its key would answer New York's question with UTC's
    // decomposition: 14:30Z is 09:30 in New York, so `30 14 * * *` is due in
    // UTC and NOT due in New York, and `30 9 * * *` is the mirror image.
    expect(isCronDue('30 14 * * *', 'UTC', NOW)).toBe(true);
    expect(isCronDue('30 14 * * *', 'America/New_York', NOW)).toBe(false);
    expect(isCronDue('30 9 * * *', 'America/New_York', NOW)).toBe(true);
    expect(isCronDue('30 9 * * *', 'UTC', NOW)).toBe(false);
    expect(formatterBuilds).toBe(2);
  });

  it('does not cache an invalid zone — every call still raises, exactly as before', () => {
    // `processSweepTick`'s per-baseline error boundary exists for precisely
    // this throw; memoising a failure would turn one bad row into a silently
    // cached one.
    expect(() => isCronDue('30 14 * * *', 'Not/AZone', NOW)).toThrow(RangeError);
    expect(() => isCronDue('30 14 * * *', 'Not/AZone', NOW)).toThrow(RangeError);
    expect(formatterBuilds).toBe(2);
  });

  it('stays correct through zone churn past the cache bound', () => {
    // The zone arrives from a DB column, so the cache is BOUNDED rather than
    // "one entry per string ever seen". Every zone the runtime supports is far
    // more than any bound worth setting, so this churns straight through it.
    const allZones = Intl.supportedValuesOf('timeZone');
    expect(allZones.length).toBeGreaterThan(200);
    for (const zone of allZones) {
      isCronDue('* * * * *', zone, NOW);
    }
    // Exactly one build per distinct zone: the bound evicts, it does not
    // thrash into rebuilding a zone twice inside one pass.
    expect(formatterBuilds).toBe(allZones.length);

    // The most recently used zone is still memoised …
    const lastZone = allZones[allZones.length - 1]!;
    expect(isCronDue('* * * * *', lastZone, NOW)).toBe(true);
    expect(formatterBuilds).toBe(allZones.length);

    // … and a zone the churn evicted is REBUILT, never served from another
    // zone's entry: 14:30Z is 23:30 in Tokyo and 15:30 in Berlin (CET).
    expect(isCronDue('30 23 * * *', 'Asia/Tokyo', NOW)).toBe(true);
    expect(isCronDue('29 23 * * *', 'Asia/Tokyo', NOW)).toBe(false);
    expect(isCronDue('30 15 * * *', 'Europe/Berlin', NOW)).toBe(true);
    expect(isCronDue('30 14 * * *', 'Europe/Berlin', NOW)).toBe(false);
  });
});
