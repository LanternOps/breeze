import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPUTE_PRICING,
  calculateComputeCents,
  computePriceMultiplier,
} from './aiComputePricing';

const HOUR_MS = 3_600_000;

afterEach(() => {
  delete process.env.AI_COMPUTE_PRICE_MULTIPLIER;
});

describe('COMPUTE_PRICING', () => {
  it('prices vercel from the verified list price and charges a 1-cent minimum', () => {
    expect(COMPUTE_PRICING.vercel).toEqual({
      cpuCentsPerHour: 12.8,
      memCentsPerGbHour: 2.12,
      minChargeCents: 1,
      minBillableWallMs: 60_000,
    });
  });

  it('prices fake at zero so unit tests need no pricing stub', () => {
    expect(COMPUTE_PRICING.fake?.minChargeCents).toBe(0);
  });

  it('leaves unimplemented backends unpriced rather than free', () => {
    expect(COMPUTE_PRICING.gvisor_pool).toBeUndefined();
    expect(COMPUTE_PRICING.agentcore).toBeUndefined();
  });
});

describe('computePriceMultiplier', () => {
  it.each([
    [undefined, 1],
    ['1', 1],
    ['2.5', 2.5],
    ['', 1],
    ['not-a-number', 1],
    ['-3', 1],
    ['0', 1],
  ])('%s → %s', (raw, expected) => {
    const env = (raw === undefined ? {} : { AI_COMPUTE_PRICE_MULTIPLIER: raw }) as NodeJS.ProcessEnv;
    expect(computePriceMultiplier(env)).toBe(expected);
  });
});

describe('calculateComputeCents', () => {
  it('throws on an unpriced backend — never returns 0 (spec §5.6)', () => {
    expect(() =>
      calculateComputeCents('gvisor_pool', { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 }, 2),
    ).toThrowError(/gvisor_pool/);
  });

  it('prices one CPU-hour at one full-memory hour correctly', () => {
    // 1 cpu-hour * 12.8 + 2 GB * 1 h * 2.12 = 12.8 + 4.24 = 17.04 -> ceil 18
    const cents = calculateComputeCents(
      'vercel',
      { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 },
      2,
    );
    expect(cents).toBe(18);
  });

  it('applies the vendor one-minute memory floor to a short run', () => {
    // 4 s of wall clock bills as 60 s of memory:
    //   cpu 1000ms   -> 12.8 * (1000/3.6e6)      = 0.003555…
    //   mem 2 GB*60s -> 2.12 * 2 * (60000/3.6e6) = 0.070666…
    //   total 0.0742… -> below the 1-cent minimum
    expect(
      calculateComputeCents('vercel', { cpuMs: 1_000, wallMs: 4_000, memAllocatedMb: 2048 }, 2),
    ).toBe(1);
  });

  it('never returns 0 for a real backend even at zero usage', () => {
    expect(calculateComputeCents('vercel', { cpuMs: 0, wallMs: 0, memAllocatedMb: 2048 }, 2)).toBe(1);
  });

  it('returns 0 for the fake backend', () => {
    expect(calculateComputeCents('fake', { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 }, 2))
      .toBe(0);
  });

  it('applies AI_COMPUTE_PRICE_MULTIPLIER at call time', () => {
    process.env.AI_COMPUTE_PRICE_MULTIPLIER = '3';
    expect(
      calculateComputeCents('vercel', { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 }, 2),
    ).toBe(52); // 17.04 * 3 = 51.12 -> ceil 52
  });

  it('rejects a non-finite or negative usage rather than billing nonsense', () => {
    expect(() =>
      calculateComputeCents('vercel', { cpuMs: Number.NaN, wallMs: 1, memAllocatedMb: 2048 }, 2),
    ).toThrowError(/usage/);
    expect(() =>
      calculateComputeCents('vercel', { cpuMs: -1, wallMs: 1, memAllocatedMb: 2048 }, 2),
    ).toThrowError(/usage/);
  });
});

describe('aiCostTracker re-exports', () => {
  it('exposes the pricing surface at the contract-named module', async () => {
    const tracker = await import('./aiCostTracker');
    expect(tracker.COMPUTE_PRICING).toBe(COMPUTE_PRICING);
    expect(tracker.calculateComputeCents).toBe(calculateComputeCents);
  });
});
