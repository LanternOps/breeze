import { describe, expect, it } from 'vitest';
import type { PresenceState } from '@breeze/shared';
import { evaluateSuggestion, type PresenceDayRow } from './presenceEligibility';

/**
 * S§10.2 table tests (site location W3, #7887). Day d is 2026-10-01 + d days (UTC); rows carry the
 * evaluation times at which the state was observed, as the evaluator writes them.
 */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const DAY0 = Date.UTC(2026, 9, 1);
const HOUR = 3_600_000;
const at = (d: number, hour: number) => new Date(DAY0 + d * 24 * HOUR + hour * HOUR).toISOString();
const dayOf = (d: number, hour: number) => at(d, hour).slice(0, 10);

const day = (d: number, state: PresenceState, matched: string | null = B, from = 8, to = 18, assigned = A): PresenceDayRow => ({
  day: dayOf(d, from), assignedSiteId: assigned, state, matchedSiteId: state === 'visiting' ? matched : null,
  firstObservedAt: at(d, from), lastObservedAt: at(d, to),
});
/** Offline overnight: stale rows from 18:00 to 08:00 the next day (explained gap). */
const nightly = (d: number, state: PresenceState = 'stale') => day(d, state, null, 18, 32);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const visitDay = (r: PresenceDayRow) => Math.round((Date.parse(`${r.day}T00:00:00Z`) - DAY0) / (24 * HOUR));

const NOW = new Date(at(10, 12));
const base = { now: NOW, assignedSiteId: A, confirmedAt: null, current: { valid: true, state: 'visiting' as const, matchedSiteId: B }, anchoredUniquely: true };
const nineDays = range(1, 10).flatMap((d) => [day(d, 'visiting'), nightly(d)]);

describe('evaluateSuggestion (S§10.2)', () => {
  it('9 visiting days spanning > 7 days with nightly stale rows → suggestion', () => {
    expect(evaluateSuggestion({ ...base, days: nineDays })).toEqual({ siteId: B, days: 9, firstObservedAt: at(1, 8), lastObservedAt: at(9, 18) });
  });

  it('6 days → none', () => {
    const rows = nineDays.filter((r) => visitDay(r) <= 6);
    expect(evaluateSuggestion({ ...base, now: new Date(at(7, 9)), days: rows })).toBeNull();
  });

  it('7 distinct days but span < 7×24h → none; an 8th day makes it eligible', () => {
    const seven = range(1, 8).flatMap((d) => [day(d, 'visiting', B, 0, 23), nightly(d)]);
    expect(evaluateSuggestion({ ...base, now: new Date(at(8, 9)), days: seven })).toBeNull();
    const eight = range(1, 9).flatMap((d) => [day(d, 'visiting', B, 0, 23), nightly(d)]);
    expect(evaluateSuggestion({ ...base, now: new Date(at(9, 9)), days: eight })).toMatchObject({ siteId: B, days: 8 });
  });

  it('any home row since first B observation → none; a home row before it does not count', () => {
    expect(evaluateSuggestion({ ...base, days: [...nineDays, day(5, 'home', null, 19, 20)] })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: [day(0, 'home', null, 8, 9), ...nineDays] })).toMatchObject({ siteId: B, days: 9 });
  });

  it('visiting another site or ambiguous → none; unrecognized does not compete', () => {
    expect(evaluateSuggestion({ ...base, days: [...nineDays, day(4, 'visiting', C, 19, 20)] })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: [...nineDays, day(4, 'ambiguous', null, 19, 20)] })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: [...nineDays, day(4, 'unrecognized', null, 19, 20)] })).toMatchObject({ days: 9 });
  });

  it('stale weekend explains the gap', () => {
    // Visits on days 1-5 and 8-11; days 6 and 7 are a powered-off weekend: stale rows only.
    const rows = [
      ...range(1, 6).flatMap((d) => [day(d, 'visiting'), nightly(d)]),
      day(6, 'stale', null, 8, 32), day(7, 'stale', null, 8, 32),
      ...range(8, 12).flatMap((d) => [day(d, 'visiting'), nightly(d)]),
    ];
    expect(evaluateSuggestion({ ...base, now: new Date(at(12, 9)), days: rows })).toMatchObject({ siteId: B, days: 9 });
  });

  it('a 35h hole is tolerated; a 40h hole without rows is unexplained', () => {
    const without = (start: number) => nineDays
      .filter((r) => !(r.state === 'stale' && visitDay(r) === 4) && !(visitDay(r) === 5))
      .map((r) => (r.state === 'visiting' && visitDay(r) === 6 ? day(6, 'visiting', B, start, 18) : r));
    // Reach after day 4 is 18:00 + 60 min; day 6 starts at 06:00 → 35h; at 11:00 → 40h.
    expect(evaluateSuggestion({ ...base, days: without(6) })).toMatchObject({ siteId: B, days: 8 });
    expect(evaluateSuggestion({ ...base, days: without(11) })).toBeNull();
  });

  it('unknown rows do not explain a gap; the same rows as stale do', () => {
    const replaced = (state: PresenceState) => nineDays
      .filter((r) => !(r.state === 'stale' && visitDay(r) === 4) && !(visitDay(r) === 5))
      .concat([nightly(4, state), day(5, state, null, 8, 18), nightly(5, state)]);
    expect(evaluateSuggestion({ ...base, days: replaced('unknown') })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: replaced('stale') })).toMatchObject({ siteId: B, days: 8 });
  });

  it('no row for more than 36h before now → none (the evaluator has not covered the device since)', () => {
    expect(evaluateSuggestion({ ...base, now: new Date(at(11, 22)), days: nineDays })).toBeNull();
  });

  it('rows from a previous assignment are ignored', () => {
    const rows = nineDays.map((r) => (visitDay(r) <= 5 ? { ...r, assignedSiteId: C } : r));
    expect(evaluateSuggestion({ ...base, days: rows })).toBeNull();
  });

  it('confirmedAt set → none; current row invalid or not visiting B → none; B no longer anchored uniquely → none', () => {
    expect(evaluateSuggestion({ ...base, days: nineDays, confirmedAt: at(9, 20) })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: nineDays, current: { ...base.current, valid: false } })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: nineDays, current: { valid: true, state: 'home', matchedSiteId: null } })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: nineDays, current: { valid: true, state: 'visiting', matchedSiteId: C } })).toBeNull();
    expect(evaluateSuggestion({ ...base, days: nineDays, anchoredUniquely: false })).toBeNull();
  });

  it('rows older than 30 days do not count', () => {
    // B visits on days -40..-35 and 1..3, with stale rows covering every hour in between: 9 distinct days in
    // total but only 3 inside the 30-day window.
    const rows = [
      ...range(-40, -34).map((d) => day(d, 'visiting', B, 0, 23)),
      ...range(-34, 1).map((d) => day(d, 'stale', null, 0, 23)),
      ...range(1, 4).map((d) => day(d, 'visiting', B, 0, 23)),
    ];
    expect(evaluateSuggestion({ ...base, now: new Date(at(3, 23)), days: rows })).toBeNull();
    // Control: the same shape with the old visits moved inside the window (days -26..-21) is eligible.
    const recent = [
      ...range(-26, -20).map((d) => day(d, 'visiting', B, 0, 23)),
      ...range(-20, 1).map((d) => day(d, 'stale', null, 0, 23)),
      ...range(1, 4).map((d) => day(d, 'visiting', B, 0, 23)),
    ];
    expect(evaluateSuggestion({ ...base, now: new Date(at(3, 23)), days: recent })).toMatchObject({ siteId: B, days: 9 });
  });
});
