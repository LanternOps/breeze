import { describe, expect, it } from 'vitest';
import { computeBillableMinutes } from './billableMinutes';

// The grid is the contract. The integration suite replays this EXACT table
// through Postgres and through the CHECK constraint; if you add a row here,
// add it there too.
export const BILLABLE_MINUTES_GRID: Array<{
  name: string;
  durationMinutes: number | null;
  minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
  expected: number | null;
}> = [
  { name: 'no terms at all → actual duration', durationMinutes: 37, minimumMinutes: null, roundingIncrementMinutes: null, expected: 37 },
  { name: 'running timer → null', durationMinutes: null, minimumMinutes: 60, roundingIncrementMinutes: 15, expected: null },
  { name: 'rounding only, exact multiple stays put', durationMinutes: 30, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 30 },
  { name: 'rounding only, rounds UP never down', durationMinutes: 31, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 45 },
  { name: 'rounding only, one minute rounds to a full block', durationMinutes: 1, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 15 },
  { name: 'zero-minute entry with rounding stays zero', durationMinutes: 0, minimumMinutes: null, roundingIncrementMinutes: 15, expected: 0 },
  { name: 'minimum only, below the floor', durationMinutes: 20, minimumMinutes: 60, roundingIncrementMinutes: null, expected: 60 },
  { name: 'minimum only, above the floor', durationMinutes: 75, minimumMinutes: 60, roundingIncrementMinutes: null, expected: 75 },
  { name: 'minimum wins over rounding', durationMinutes: 20, minimumMinutes: 60, roundingIncrementMinutes: 15, expected: 60 },
  { name: 'rounding wins over minimum', durationMinutes: 61, minimumMinutes: 60, roundingIncrementMinutes: 15, expected: 75 },
  { name: 'they tie', durationMinutes: 55, minimumMinutes: 60, roundingIncrementMinutes: 60, expected: 60 },
  { name: 'increment 0 is treated as no rounding, not a divide by zero', durationMinutes: 37, minimumMinutes: null, roundingIncrementMinutes: 0, expected: 37 },
  { name: 'minimum 0 is not a floor', durationMinutes: 7, minimumMinutes: 0, roundingIncrementMinutes: null, expected: 7 },
  { name: 'increment 1 is a no-op', durationMinutes: 37, minimumMinutes: null, roundingIncrementMinutes: 1, expected: 37 },
  { name: 'increment 480 (the §4.2 ceiling)', durationMinutes: 1, minimumMinutes: null, roundingIncrementMinutes: 480, expected: 480 },
  { name: 'long entry, 6-minute increment', durationMinutes: 487, minimumMinutes: null, roundingIncrementMinutes: 6, expected: 492 },
];

describe('computeBillableMinutes', () => {
  for (const row of BILLABLE_MINUTES_GRID) {
    it(row.name, () => {
      expect(
        computeBillableMinutes({
          durationMinutes: row.durationMinutes,
          minimumMinutes: row.minimumMinutes,
          roundingIncrementMinutes: row.roundingIncrementMinutes,
        })
      ).toBe(row.expected);
    });
  }

  it('never returns a non-integer even with an awkward increment', () => {
    const out = computeBillableMinutes({ durationMinutes: 100, minimumMinutes: null, roundingIncrementMinutes: 7 });
    expect(out).toBe(105);
    expect(Number.isInteger(out)).toBe(true);
  });
});

/**
 * NOT a regression test — it documents the contract #4547 must implement.
 *
 * Block hours are unbuilt, so there is no drawdown code to exercise: the
 * helpers below are defined in this file and asserted against themselves, and
 * they will keep passing however `src/` changes. They are here so the decision
 * is written down where the person building #4547 will read it, and the name
 * says so plainly rather than leaving a future reader to believe drawdown is
 * covered by a test. When #4547 lands, these move onto its real function.
 */
describe('block hours (#4547 §5): the contract W03 hands forward — documentation, not coverage', () => {
  const drawdownMinutes = (r: { durationMinutes: number | null; billableMinutes: number | null }) =>
    (r.billableMinutes ?? r.durationMinutes) ?? 0;

  it('a block draws the BILLED quantity, so a 1 h minimum consumes an hour', () => {
    expect(drawdownMinutes({ durationMinutes: 20, billableMinutes: 60 })).toBe(60);
  });

  it('a pre-feature entry draws its actual duration', () => {
    expect(drawdownMinutes({ durationMinutes: 30, billableMinutes: null })).toBe(30);
  });

  it('INCLUDED hours never draw a block: they are born billing_status=contract, so they never reach drawdown', () => {
    // §5, decision 3 (closed 2026-09-19). "Included" means covered by the flat
    // fee; block eligibility requires a not_billed entry. This assertion pins
    // the ELIGIBILITY predicate, which is the thing that keeps them out — the
    // minute count above is irrelevant if the row is never a candidate.
    const isBlockEligible = (r: { billingStatus: string; isBillable: boolean }) =>
      r.isBillable && r.billingStatus === 'not_billed';
    expect(isBlockEligible({ billingStatus: 'contract', isBillable: true })).toBe(false);
    expect(isBlockEligible({ billingStatus: 'not_billed', isBillable: true })).toBe(true);
  });
});
