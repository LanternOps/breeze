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
import { evaluateConditions, findUnregisteredConditionTypes, unsupportedConditionTypeError } from './index';
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

describe('findUnregisteredConditionTypes (issue #2948)', () => {
  it('flags the retired `custom` type, which never had a handler', () => {
    expect(findUnregisteredConditionTypes([{ type: 'custom', customCondition: 'x' }])).toEqual(['custom']);
  });

  it('accepts every type the registry actually resolves, aliases included', () => {
    const supported = [
      { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
      { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 85 },
      { type: 'status', duration: 10 },
      { type: 'offline', durationMinutes: 10 },
      { type: 'event_log', category: 'system', level: 'error' },
      { type: 'service_stopped', serviceName: 'spooler' },
      { type: 'cert_expiry', withinDays: 30 },
    ];
    expect(findUnregisteredConditionTypes(supported)).toEqual([]);
  });

  it('walks into nested condition groups', () => {
    const tree = {
      logic: 'or',
      conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 },
        { logic: 'and', conditions: [{ type: 'custom' }, { type: 'made_up' }] },
      ],
    };
    expect(findUnregisteredConditionTypes(tree)).toEqual(['custom', 'made_up']);
  });

  it('dedupes repeated unknown types', () => {
    expect(findUnregisteredConditionTypes([{ type: 'custom' }, { type: 'custom' }])).toEqual(['custom']);
  });

  it('ignores non-object and typeless nodes rather than inventing an error', () => {
    // A missing/non-string `type` is the per-handler validators' problem, not
    // this function's — it reports unknown TYPES only.
    expect(findUnregisteredConditionTypes([null, 'nope', 42, {}, { type: 7 }])).toEqual([]);
  });

  it('stops recursing on a pathologically deep tree instead of blowing the stack', () => {
    let node: Record<string, unknown> = { type: 'custom' };
    for (let i = 0; i < 5000; i++) node = { logic: 'and', conditions: [node] };
    expect(() => findUnregisteredConditionTypes(node)).not.toThrow();
  });
});

describe('unsupportedConditionTypeError (issue #2948)', () => {
  it('returns null when nothing was supplied', () => {
    expect(unsupportedConditionTypeError(undefined)).toBeNull();
    expect(unsupportedConditionTypeError(null)).toBeNull();
  });

  it('returns null for a supported condition', () => {
    expect(unsupportedConditionTypeError([{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }])).toBeNull();
  });

  it('names the offending type and the supported ones', () => {
    const message = unsupportedConditionTypeError([{ type: 'custom' }]);
    expect(message).toContain('custom');
    expect(message).toContain('never fire');
    expect(message).toContain('offline');
  });
});
