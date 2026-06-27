import { describe, it, expect, vi, beforeEach } from 'vitest';

// utils.ts (transitively imported by the handlers) pulls in the db module at
// import time; stub it so importing the registry doesn't open a connection.
vi.mock('../../db', () => ({ db: {} }));

const { getRecentMetricsMock, getLatestMetricMock } = vi.hoisted(() => ({
  getRecentMetricsMock: vi.fn(),
  getLatestMetricMock: vi.fn(),
}));

// Mock only the db-touching helpers; keep the pure metric-map/compare helpers real.
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils')>();
  return { ...actual, getRecentMetrics: getRecentMetricsMock, getLatestMetric: getLatestMetricMock };
});

import './index';
import { evaluateConditions } from './index';
import { conditionRegistry } from './registry';
import { offlineHandler } from './handlers/offline';

describe('condition registry wiring (issue #1857)', () => {
  it('resolves the legacy "status" condition type to the offline handler', () => {
    expect(conditionRegistry.get('status')).toBe(offlineHandler);
  });

  it('resolves the canonical "offline" condition type to the offline handler', () => {
    expect(conditionRegistry.get('offline')).toBe(offlineHandler);
  });

  it('returns an "Unknown condition type" result for a genuinely unregistered type', async () => {
    const result = await conditionRegistry.evaluate(
      { type: 'definitely-not-a-real-type' } as never,
      'device-1'
    );
    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/Unknown condition type/);
  });
});

describe('evaluateConditions context.actualValue (issue #1980)', () => {
  beforeEach(() => {
    getRecentMetricsMock.mockReset();
    getLatestMetricMock.mockReset();
  });

  it('reports the window average (not the latest raw sample) for a fired metric rule', async () => {
    // avg(88, 95, 94) = 92.33 > 90 → fires. Latest raw sample is 88 (sub-threshold).
    getRecentMetricsMock.mockResolvedValue([
      { ramPercent: 88 },
      { ramPercent: 95 },
      { ramPercent: 94 },
    ] as never);
    getLatestMetricMock.mockResolvedValue({ ramPercent: 88 } as never);

    const result = await evaluateConditions(
      [{ type: 'metric', metric: 'ram', operator: 'gt', value: 90 }],
      'device-1'
    );

    expect(result.triggered).toBe(true);
    expect(result.context.metric).toBe('ram');
    expect(result.context.actualValue).toBeCloseTo(92.33, 1);
    // Must not be the latest sub-threshold sample.
    expect(result.context.actualValue).not.toBe(88);
  });
});
