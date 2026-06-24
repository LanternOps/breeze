import { describe, it, expect } from 'vitest';
import { METRIC_NAME_MAP, normalizeMetricName, compareValue } from './utils';

describe('METRIC_NAME_MAP', () => {
  it('maps the UI percentage metrics to their device_metrics columns', () => {
    expect(METRIC_NAME_MAP.cpu).toBe('cpuPercent');
    expect(METRIC_NAME_MAP.ram).toBe('ramPercent');
    expect(METRIC_NAME_MAP.memory).toBe('ramPercent');
    expect(METRIC_NAME_MAP.disk).toBe('diskPercent');
  });

  it('does NOT map "network" — there is no network-usage percentage column (issue #1857)', () => {
    // The dead "Network Usage" option was removed from the editor; ensure the
    // evaluator likewise treats it as unknown rather than silently mismapping.
    expect(METRIC_NAME_MAP.network).toBeUndefined();
    expect(normalizeMetricName('network')).toBeNull();
  });

  it('round-trips the canonical column names through normalizeMetricName', () => {
    expect(normalizeMetricName('cpuPercent')).toBe('cpuPercent');
    expect(normalizeMetricName('diskPercent')).toBe('diskPercent');
    expect(normalizeMetricName('processCount')).toBe('processCount');
  });
});

describe('compareValue', () => {
  it('evaluates each operator', () => {
    expect(compareValue(90, 'gt', 80)).toBe(true);
    expect(compareValue(80, 'gte', 80)).toBe(true);
    expect(compareValue(70, 'lt', 80)).toBe(true);
    expect(compareValue(80, 'lte', 80)).toBe(true);
    expect(compareValue(80, 'eq', 80)).toBe(true);
    expect(compareValue(81, 'neq', 80)).toBe(true);
  });
});
