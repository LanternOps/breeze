import { beforeEach, describe, expect, it, vi } from 'vitest';

const drizzleSpies = vi.hoisted(() => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ __op: 'eq', column, value })),
  and: vi.fn((...clauses: unknown[]) => ({ __op: 'and', clauses })),
  lt: vi.fn((column: unknown, value: unknown) => ({ __op: 'lt', column, value })),
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return { ...actual, eq: drizzleSpies.eq, and: drizzleSpies.and, lt: drizzleSpies.lt };
});

const dbMocks = vi.hoisted(() => {
  const state: { queue: unknown[][] } = { queue: [] };
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(state.queue.shift() ?? [])),
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(state.queue.shift() ?? [])),
      })),
    })),
  }));
  return { state, select };
});

vi.mock('../../db', () => ({
  db: { select: dbMocks.select },
}));

import { devices } from '../../db/schema/devices';
import { deviceReliability } from '../../db/schema/reliability';
import {
  produceLogCorrelationFindings,
  produceMetricAnomalyPatterns,
  produceReliabilityOffenders,
} from './producers';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  dbMocks.state.queue = [];
  dbMocks.select.mockClear();
  drizzleSpies.eq.mockClear();
  drizzleSpies.and.mockClear();
  drizzleSpies.lt.mockClear();
});

describe('produceMetricAnomalyPatterns', () => {
  function anomalyRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'anomaly-1',
      deviceId: 'device-a',
      metricName: 'cpu_percent',
      anomalyType: 'spike',
      score: 3,
      observedValue: 95,
      baselineValue: 40,
      ...overrides,
    };
  }

  it('groups open anomalies by (metric_name, anomaly_type) and requires >=2 devices', async () => {
    dbMocks.state.queue = [[
      anomalyRow({ id: 'a1', deviceId: 'device-a' }),
      anomalyRow({ id: 'a2', deviceId: 'device-b' }),
      // A different metric/anomalyType pair with only one device — must be dropped.
      anomalyRow({ id: 'a3', deviceId: 'device-c', metricName: 'disk_io', anomalyType: 'drift' }),
    ]];

    const result = await produceMetricAnomalyPatterns(ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('metric_anomaly_pattern');
    expect(result[0]!.semanticKey).toBe('metric:cpu_percent:spike');
    expect(result[0]!.members.map((m) => m.deviceId).sort()).toEqual(['device-a', 'device-b']);
  });

  it('sets severity critical when any member score >= 4, else warning', async () => {
    dbMocks.state.queue = [[
      anomalyRow({ id: 'a1', deviceId: 'device-a', score: 4.2 }),
      anomalyRow({ id: 'a2', deviceId: 'device-b', score: 2.1 }),
    ]];
    let result = await produceMetricAnomalyPatterns(ORG_ID);
    expect(result[0]!.severity).toBe('critical');

    dbMocks.state.queue = [[
      anomalyRow({ id: 'a1', deviceId: 'device-a', score: 3.9 }),
      anomalyRow({ id: 'a2', deviceId: 'device-b', score: 2.1 }),
    ]];
    result = await produceMetricAnomalyPatterns(ORG_ID);
    expect(result[0]!.severity).toBe('warning');
  });

  it('caps evidence samples at 20 members while keeping all members', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      anomalyRow({ id: `a${i}`, deviceId: `device-${i}`, score: i }));
    dbMocks.state.queue = [rows];

    const result = await produceMetricAnomalyPatterns(ORG_ID);

    expect(result[0]!.members).toHaveLength(25);
    const evidence = result[0]!.evidence as { samples: unknown[] };
    expect(evidence.samples.length).toBeLessThanOrEqual(20);
  });

  it('deduplicates multiple open rows for the same device (keeps the worst)', async () => {
    dbMocks.state.queue = [[
      anomalyRow({ id: 'a1', deviceId: 'device-a', score: 2 }),
      anomalyRow({ id: 'a2', deviceId: 'device-a', score: 5 }),
      anomalyRow({ id: 'a3', deviceId: 'device-b', score: 1 }),
    ]];

    const result = await produceMetricAnomalyPatterns(ORG_ID);

    expect(result[0]!.members).toHaveLength(2);
    const deviceA = result[0]!.members.find((m) => m.deviceId === 'device-a')!;
    expect(deviceA.memberEvidence).toMatchObject({ score: 5 });
  });

  it('scopes the query to this org and open status', async () => {
    dbMocks.state.queue = [[]];
    await produceMetricAnomalyPatterns(ORG_ID);
    expect(drizzleSpies.and).toHaveBeenCalled();
    const andArgs = drizzleSpies.and.mock.calls[0]!;
    expect(andArgs).toEqual(expect.arrayContaining([
      { __op: 'eq', column: expect.anything(), value: ORG_ID },
      { __op: 'eq', column: expect.anything(), value: 'open' },
    ]));
  });
});

describe('produceLogCorrelationFindings', () => {
  function correlationRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'corr-1',
      ruleId: 'rule-1',
      pattern: 'disk failure imminent',
      occurrences: 10,
      affectedDevices: [
        { deviceId: 'device-a', hostname: 'host-a', count: 6 },
        { deviceId: 'device-b', hostname: 'host-b', count: 4 },
      ],
      ruleName: 'Disk Failure Pattern',
      ruleSeverity: 'error',
      ...overrides,
    };
  }

  it('maps 1:1 from active log_correlations rows keyed by rule id', async () => {
    dbMocks.state.queue = [[correlationRow()]];

    const result = await produceLogCorrelationFindings(ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('log_correlation');
    expect(result[0]!.semanticKey).toBe('logcorr:rule-1');
    expect(result[0]!.members.map((m) => m.deviceId).sort()).toEqual(['device-a', 'device-b']);
  });

  it('maps rule severity 1:1 onto the finding severity', async () => {
    for (const sev of ['info', 'warning', 'error', 'critical'] as const) {
      dbMocks.state.queue = [[correlationRow({ ruleSeverity: sev })]];
      const result = await produceLogCorrelationFindings(ORG_ID);
      expect(result[0]!.severity).toBe(sev);
    }
  });

  it('titles the finding from the rule name, falling back to the raw pattern', async () => {
    dbMocks.state.queue = [[correlationRow({ ruleName: 'Disk Failure Pattern' })]];
    let result = await produceLogCorrelationFindings(ORG_ID);
    expect(result[0]!.title).toBe('Log pattern: Disk Failure Pattern');

    dbMocks.state.queue = [[correlationRow({ ruleName: null, pattern: 'raw pattern text' })]];
    result = await produceLogCorrelationFindings(ORG_ID);
    expect(result[0]!.title).toBe('Log pattern: raw pattern text');
  });

  it('merges affectedDevices across multiple active rows for the same rule', async () => {
    dbMocks.state.queue = [[
      correlationRow({ id: 'corr-1', affectedDevices: [{ deviceId: 'device-a', hostname: 'host-a', count: 3 }] }),
      correlationRow({ id: 'corr-2', affectedDevices: [{ deviceId: 'device-a', hostname: 'host-a', count: 2 }, { deviceId: 'device-c', hostname: 'host-c', count: 1 }] }),
    ]];

    const result = await produceLogCorrelationFindings(ORG_ID);

    expect(result).toHaveLength(1);
    const deviceA = result[0]!.members.find((m) => m.deviceId === 'device-a')!;
    expect(deviceA.memberEvidence).toMatchObject({ count: 5 });
    expect(result[0]!.members.map((m) => m.deviceId).sort()).toEqual(['device-a', 'device-c']);
  });
});

describe('produceReliabilityOffenders', () => {
  function reliabilityRow(overrides: Partial<Record<string, unknown>> = {}) {
    return { deviceId: 'device-a', reliabilityScore: 40, ...overrides };
  }

  it('skips creating a candidate entirely when there are zero offenders', async () => {
    dbMocks.state.queue = [[]];
    const result = await produceReliabilityOffenders(ORG_ID);
    expect(result).toEqual([]);
  });

  it('produces a single org-wide finding keyed reliability:offenders', async () => {
    dbMocks.state.queue = [[reliabilityRow({ deviceId: 'device-a', reliabilityScore: 40 }), reliabilityRow({ deviceId: 'device-b', reliabilityScore: 45 })]];
    const result = await produceReliabilityOffenders(ORG_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('reliability_offenders');
    expect(result[0]!.semanticKey).toBe('reliability:offenders');
    expect(result[0]!.title).toBe('Low reliability: 2 devices below 50');
  });

  it('sets severity error when any device scores below 25, else warning', async () => {
    dbMocks.state.queue = [[reliabilityRow({ deviceId: 'device-a', reliabilityScore: 24 })]];
    let result = await produceReliabilityOffenders(ORG_ID);
    expect(result[0]!.severity).toBe('error');

    dbMocks.state.queue = [[reliabilityRow({ deviceId: 'device-a', reliabilityScore: 30 })]];
    result = await produceReliabilityOffenders(ORG_ID);
    expect(result[0]!.severity).toBe('warning');
  });

  it('filters out ephemeral devices via the codebase-standard isEphemeral=false predicate', async () => {
    dbMocks.state.queue = [[reliabilityRow()]];
    await produceReliabilityOffenders(ORG_ID);
    expect(drizzleSpies.eq).toHaveBeenCalledWith(devices.isEphemeral, false);
    expect(drizzleSpies.lt).toHaveBeenCalledWith(deviceReliability.reliabilityScore, 50);
  });
});
