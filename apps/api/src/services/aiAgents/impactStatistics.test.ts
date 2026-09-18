import { describe, expect, it } from 'vitest';

import { buildArm, kaplanMeierQuantile, median, proportionWithinHorizon } from './impactStatistics';

const observed = (minutes: number) => ({ minutes, observed: true });
const censored = (minutes: number) => ({ minutes, observed: false });

describe('proportionWithinHorizon', () => {
  it('counts only OBSERVED outcomes inside the horizon', () => {
    const obs = [
      observed(10), // in
      observed(30), // in
      observed(90), // out (past horizon)
      censored(20), // censored at 20 -- NOT a success
    ];
    expect(proportionWithinHorizon(obs, 60)).toBeCloseTo(2 / 4);
  });

  it('counts an outcome exactly at the horizon as inside it', () => {
    expect(proportionWithinHorizon([observed(60), observed(61)], 60)).toBeCloseTo(1 / 2);
  });

  it('is 0, not NaN, for an empty arm', () => {
    expect(proportionWithinHorizon([], 60)).toBe(0);
  });

  it('a censored item stays in the denominator', () => {
    // Dropping still-open items would flatter whichever arm has more of them.
    expect(proportionWithinHorizon([observed(10), censored(5)], 60)).toBeCloseTo(1 / 2);
  });
});

describe('kaplanMeierQuantile', () => {
  it('matches a hand-computed median with no censoring', () => {
    // S drops 1 -> .8 -> .6 -> .4 at t=30, which is the first time S <= .5.
    const obs = [10, 20, 30, 40, 50].map(observed);
    expect(kaplanMeierQuantile(obs, 0.5)).toBe(30);
  });

  it('returns null when survival never drops to the quantile', () => {
    // One event then 19 censored: S(t) bottoms out at 0.95 and never reaches 0.5.
    const obs = [observed(5), ...Array.from({ length: 19 }, () => censored(6))];
    expect(kaplanMeierQuantile(obs, 0.5)).toBeNull();
  });

  it('a censored observation does NOT count as a resolution', () => {
    const allCensored = Array.from({ length: 30 }, () => censored(10));
    expect(kaplanMeierQuantile(allCensored, 0.5)).toBeNull();
  });

  it('censoring RAISES the estimate versus dropping the censored rows', () => {
    // The whole reason we censor: dropping still-open items biases the arm fast.
    // Hand-computed. With censoring, n=5:
    //   t=10 -> 1 event of 5 at risk, S = 0.8 (not yet <= 0.5)
    //   t=15 -> 3 censored leave, 1 at risk
    //   t=20 -> 1 event of 1 at risk, S = 0  => p50 = 20
    // Dropping the censored rows leaves [10, 20], n=2:
    //   t=10 -> 1 event of 2 at risk, S = 0.5 => p50 = 10
    // Both branches produce a NUMBER, so the comparison below actually runs
    // rather than being satisfied by a null short-circuit.
    const withCensored = [observed(10), censored(15), censored(15), censored(15), observed(20)];
    const droppingThem = [observed(10), observed(20)];
    const km = kaplanMeierQuantile(withCensored, 0.5);
    const naive = kaplanMeierQuantile(droppingThem, 0.5);

    expect(naive).toBe(10);
    expect(km).toBe(20);
    expect(km!).toBeGreaterThan(naive!);
  });

  it('separates p50 from p90 on a spread of distinct event times', () => {
    // Ten uncensored events, one per decile: S falls 0.9, 0.8, ... 0.1, 0.0.
    // p50 is the first t with S <= 0.5 (t=50); p90 the first with S <= 0.1
    // (t=90). Transposing the two quantile arguments in buildArm would swap
    // these, which every single-event-time fixture is blind to.
    const obs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(observed);

    expect(kaplanMeierQuantile(obs, 0.5)).toBe(50);
    expect(kaplanMeierQuantile(obs, 0.9)).toBe(90);
  });

  it('handles ties at one event time as a single risk-set step', () => {
    // 4 events at t=10 out of 8 at risk -> S = 0.5 at t=10.
    const obs = [...Array.from({ length: 4 }, () => observed(10)), ...Array.from({ length: 4 }, () => observed(50))];
    expect(kaplanMeierQuantile(obs, 0.5)).toBe(10);
  });

  it('is null for an empty arm', () => {
    expect(kaplanMeierQuantile([], 0.5)).toBeNull();
  });
});

describe('median', () => {
  it('is the middle value of an odd-length sample', () => {
    expect(median([1, 2, 3])).toBe(2);
  });

  it('averages the two middle values of an even-length sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('sorts numerically, not lexicographically', () => {
    // [5, 9, 10] sorted as strings is [10, 5, 9] -> a median of 5.
    expect(median([9, 5, 10])).toBe(9);
  });

  it('is null, not 0, for an empty sample', () => {
    // An absent time entry is missing information, not zero labour.
    expect(median([])).toBeNull();
  });
});

describe('buildArm', () => {
  it('returns null below the display gate of 20', () => {
    expect(buildArm(Array.from({ length: 19 }, () => observed(5)), 60)).toBeNull();
  });

  it('returns an arm at exactly 20', () => {
    expect(buildArm(Array.from({ length: 20 }, () => observed(5)), 60)).toMatchObject({
      n: 20,
      proportionWithinHorizon: 1,
      censoredP50Minutes: 5,
    });
  });

  it('does not transpose p50 and p90', () => {
    const arm = buildArm([10, 20, 30, 40, 50, 60, 70, 80, 90, 100].flatMap((m) => [observed(m), observed(m)]), 60);
    expect(arm!.censoredP50Minutes).toBe(50);
    expect(arm!.censoredP90Minutes).toBe(90);
  });

  it('emits null quantiles rather than a fabricated number when they are not estimable', () => {
    const arm = buildArm(Array.from({ length: 25 }, () => censored(5)), 60);
    expect(arm).toMatchObject({ n: 25, proportionWithinHorizon: 0, censoredP50Minutes: null, censoredP90Minutes: null });
  });
});
