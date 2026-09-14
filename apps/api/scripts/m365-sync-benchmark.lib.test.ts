import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_PASS_CRITERIA,
  makeSizeDistribution,
  parseBenchmarkArgs,
  percentile,
} from './m365-sync-benchmark.lib';

describe('parseBenchmarkArgs', () => {
  it('defaults to the spec §5.11 shape', () => {
    expect(parseBenchmarkArgs([])).toEqual({
      orgs: 1_000,
      windowMinutes: 60,
      executorLatencyMs: 200,
      concurrency: 4,
      tickBatch: 200,
      probeIntervalMs: 1_000,
      seed: 20260908,
      keepData: false,
    });
  });

  it('accepts overrides and rejects nonsense', () => {
    expect(parseBenchmarkArgs(['--orgs=50', '--window-minutes=5', '--keep-data']))
      .toMatchObject({ orgs: 50, windowMinutes: 5, keepData: true });
    expect(() => parseBenchmarkArgs(['--orgs=0'])).toThrow(/--orgs/);
    expect(() => parseBenchmarkArgs(['--orgs=abc'])).toThrow(/--orgs/);
    expect(() => parseBenchmarkArgs(['--nope'])).toThrow(/unknown/i);
  });

  it('tolerates a stray "--" (pnpm forwards it literally, it does not strip it)', () => {
    expect(parseBenchmarkArgs(['--', '--orgs=50'])).toMatchObject({ orgs: 50 });
  });
});

describe('makeSizeDistribution', () => {
  const sizes = makeSizeDistribution(1_000, 20260908);

  it('produces one entry per org', () => {
    expect(sizes).toHaveLength(1_000);
  });

  it('hits the spec median (60 users / 40 devices) within 10 %', () => {
    expect(percentile(sizes.map((size) => size.users), 50)).toBeGreaterThanOrEqual(54);
    expect(percentile(sizes.map((size) => size.users), 50)).toBeLessThanOrEqual(66);
    expect(percentile(sizes.map((size) => size.devices), 50)).toBeGreaterThanOrEqual(36);
    expect(percentile(sizes.map((size) => size.devices), 50)).toBeLessThanOrEqual(44);
  });

  it('hits the spec p95 (2000 users / 1500 devices) within 15 %', () => {
    expect(percentile(sizes.map((size) => size.users), 95)).toBeGreaterThanOrEqual(1_700);
    expect(percentile(sizes.map((size) => size.users), 95)).toBeLessThanOrEqual(2_300);
    expect(percentile(sizes.map((size) => size.devices), 95)).toBeGreaterThanOrEqual(1_275);
    expect(percentile(sizes.map((size) => size.devices), 95)).toBeLessThanOrEqual(1_725);
  });

  it('always includes exactly two 25k tenants', () => {
    expect(sizes.filter((size) => size.users === 25_000)).toHaveLength(2);
    expect(sizes.filter((size) => size.devices === 25_000)).toHaveLength(2);
  });

  it('is deterministic for a given seed', () => {
    expect(makeSizeDistribution(50, 7)).toEqual(makeSizeDistribution(50, 7));
    expect(makeSizeDistribution(50, 7)).not.toEqual(makeSizeDistribution(50, 8));
  });
});

describe('percentile', () => {
  it('interpolates nothing — it takes the nearest-rank sample', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('BENCHMARK_PASS_CRITERIA', () => {
  it('is written down before the run, not derived from it', () => {
    expect(BENCHMARK_PASS_CRITERIA).toMatchObject({
      tickerUtilisationMax: 0.5,
      tickDrainSecondsMax: 60,
      queueDepthMax: 500,
      poolOccupancyFractionMax: 0.5,
      probeP95MillisecondsMax: 50,
      steadyStateEntityWritesMax: 0,
    });
  });
});
