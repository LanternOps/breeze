import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getRecentMetricsMock } = vi.hoisted(() => ({
  getRecentMetricsMock: vi.fn(),
}));

// getRecentMetrics touches the db; mock only it and keep the pure helpers real.
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return { ...actual, getRecentMetrics: getRecentMetricsMock };
});

import { thresholdHandler } from './threshold';

const DEVICE_ID = 'device-1';

/** Build deviceMetrics-shaped rows from a list of values for a single column. */
function rows(column: string, values: Array<number | null>) {
  return values.map((v) => ({ [column]: v })) as never[];
}

describe('thresholdHandler (averaged window semantics)', () => {
  beforeEach(() => {
    getRecentMetricsMock.mockReset();
  });

  it('declares type "threshold" with a "metric" alias', () => {
    expect(thresholdHandler.type).toBe('threshold');
    expect(thresholdHandler.aliases).toContain('metric');
  });

  it('fires when the window AVERAGE exceeds the threshold even though some samples dip below', async () => {
    // avg(95, 88, 94) = 92.33 > 90. Strict all-samples (.every) would NOT fire because 88 < 90.
    getRecentMetricsMock.mockResolvedValue(rows('ramPercent', [95, 88, 94]));

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'ram', operator: 'gt', value: 90 },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });

  it('does NOT fire when the average is below the threshold even if a single sample spikes above', async () => {
    // avg(99, 80, 80) = 86.33, threshold gt 90 → no fire.
    getRecentMetricsMock.mockResolvedValue(rows('cpuPercent', [99, 80, 80]));

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('skips null samples instead of counting them as below-threshold', async () => {
    // Non-null avg(94, 92) = 93 > 90. With null-as-fail this would never fire.
    getRecentMetricsMock.mockResolvedValue(rows('diskPercent', [94, null, 92]));

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'disk', operator: 'gt', value: 90 },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });

  it('reports the averaged value it evaluated as actualValue', async () => {
    getRecentMetricsMock.mockResolvedValue(rows('ramPercent', [90, 100]));

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'ram', operator: 'gt', value: 80 },
      DEVICE_ID
    );

    expect(result.actualValue).toBe(95);
  });

  it('does not fire when every sample in the window is null', async () => {
    getRecentMetricsMock.mockResolvedValue(rows('ramPercent', [null, null]));

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'ram', operator: 'gt', value: 50 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('returns "No metrics available" when the window is empty', async () => {
    getRecentMetricsMock.mockResolvedValue([]);

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
    expect(result.description).toContain('No metrics');
  });

  it('returns "Unknown metric" for an unmapped metric name', async () => {
    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'network', operator: 'gt', value: 50 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
    expect(result.description).toContain('Unknown metric');
  });

  it('treats cpu/ram/disk symmetrically (disk averaged the same way)', async () => {
    // avg(86, 84) = 85, threshold gte 85 → fire.
    getRecentMetricsMock.mockResolvedValue(rows('diskPercent', [86, 84]));

    const result = await thresholdHandler.evaluate(
      { type: 'metric', metric: 'disk', operator: 'gte', value: 85 },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });
});
