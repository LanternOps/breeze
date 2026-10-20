import { describe, expect, it } from 'vitest';
import { contractsOverlapCadence, RELATED_CONTRACT_STATUSES } from './relatedContracts';

const base = { intervalMonths: 1, startDate: '2026-07-01', endDate: null as string | null };

describe('contractsOverlapCadence (#9303)', () => {
  it('is true for the same cadence with open-ended ranges', () => {
    expect(contractsOverlapCadence(base, { ...base, startDate: '2027-03-01' })).toBe(true);
  });

  it('is false when the cadence differs, even with identical dates', () => {
    expect(contractsOverlapCadence(base, { ...base, intervalMonths: 12 })).toBe(false);
  });

  it('is false when one range ends before the other starts', () => {
    expect(contractsOverlapCadence(
      { ...base, endDate: '2026-12-31' },
      { ...base, startDate: '2027-01-01' },
    )).toBe(false);
    // symmetric
    expect(contractsOverlapCadence(
      { ...base, startDate: '2027-01-01' },
      { ...base, endDate: '2026-12-31' },
    )).toBe(false);
  });

  it('treats a shared boundary day as an overlap (both bill that day)', () => {
    expect(contractsOverlapCadence(
      { ...base, endDate: '2026-12-31' },
      { ...base, startDate: '2026-12-31' },
    )).toBe(true);
  });

  it('is true when one closed range sits inside the other', () => {
    expect(contractsOverlapCadence(
      { ...base, startDate: '2026-01-01', endDate: '2027-12-31' },
      { ...base, startDate: '2026-06-01', endDate: '2026-08-31' },
    )).toBe(true);
  });

  it('names the statuses that can still bill', () => {
    expect([...RELATED_CONTRACT_STATUSES]).toEqual(['draft', 'active', 'paused']);
  });
});
