/**
 * Occurrence math for the fixed-tick sweeper (Phase 2 wave P2-2, task 9).
 *
 * Pure — no DB, no clock. Every case below pins a real DST edge in
 * Europe/Berlin, because the whole reason this module exists rather than a
 * bare `isCronDue(now)` check is that a 5-minute tick must fire a
 * once-a-day schedule exactly once even when the local wall clock repeats or
 * skips an hour.
 */
import { describe, expect, it } from 'vitest';
import {
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
