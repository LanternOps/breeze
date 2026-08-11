import { beforeEach, describe, expect, it, vi } from 'vitest';

const drizzleSpies = vi.hoisted(() => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ __op: 'eq', column, value })),
  and: vi.fn((...clauses: unknown[]) => ({ __op: 'and', clauses })),
  lt: vi.fn((column: unknown, value: unknown) => ({ __op: 'lt', column, value })),
  ne: vi.fn((column: unknown, value: unknown) => ({ __op: 'ne', column, value })),
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return { ...actual, eq: drizzleSpies.eq, and: drizzleSpies.and, lt: drizzleSpies.lt, ne: drizzleSpies.ne };
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

// Rows returned by the `loadEligibleDeviceIds` lookup (log-correlation producer
// only — the other two producers filter in SQL via their `devices` innerJoin).
function eligibleDevices(...ids: string[]) {
  return ids.map((id) => ({ id }));
}

beforeEach(() => {
  dbMocks.state.queue = [];
  dbMocks.select.mockClear();
  drizzleSpies.eq.mockClear();
  drizzleSpies.and.mockClear();
  drizzleSpies.lt.mockClear();
  drizzleSpies.ne.mockClear();
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

  it('joins devices to exclude ephemeral and decommissioned devices', async () => {
    dbMocks.state.queue = [[]];
    await produceMetricAnomalyPatterns(ORG_ID);
    expect(drizzleSpies.eq).toHaveBeenCalledWith(devices.isEphemeral, false);
    expect(drizzleSpies.ne).toHaveBeenCalledWith(devices.status, 'decommissioned');
    // Both predicates must sit in the same where-clause as the org/status scope
    // (i.e. the join actually filters, rather than only widening the row shape).
    expect(drizzleSpies.and.mock.calls[0]!).toEqual(expect.arrayContaining([
      { __op: 'eq', column: devices.isEphemeral, value: false },
      { __op: 'ne', column: devices.status, value: 'decommissioned' },
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
    dbMocks.state.queue = [[correlationRow()], eligibleDevices('device-a', 'device-b')];

    const result = await produceLogCorrelationFindings(ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('log_correlation');
    expect(result[0]!.semanticKey).toBe('logcorr:rule-1');
    expect(result[0]!.members.map((m) => m.deviceId).sort()).toEqual(['device-a', 'device-b']);
  });

  it('maps rule severity 1:1 onto the finding severity', async () => {
    for (const sev of ['info', 'warning', 'error', 'critical'] as const) {
      dbMocks.state.queue = [[correlationRow({ ruleSeverity: sev })], eligibleDevices('device-a', 'device-b')];
      const result = await produceLogCorrelationFindings(ORG_ID);
      expect(result[0]!.severity).toBe(sev);
    }
  });

  it('titles the finding from the rule name, falling back to the raw pattern', async () => {
    dbMocks.state.queue = [[correlationRow({ ruleName: 'Disk Failure Pattern' })], eligibleDevices('device-a', 'device-b')];
    let result = await produceLogCorrelationFindings(ORG_ID);
    expect(result[0]!.title).toBe('Log pattern: Disk Failure Pattern');

    dbMocks.state.queue = [[correlationRow({ ruleName: null, pattern: 'raw pattern text' })], eligibleDevices('device-a', 'device-b')];
    result = await produceLogCorrelationFindings(ORG_ID);
    expect(result[0]!.title).toBe('Log pattern: raw pattern text');
  });

  it('merges affectedDevices across multiple active rows for the same rule', async () => {
    dbMocks.state.queue = [[
      correlationRow({ id: 'corr-1', affectedDevices: [{ deviceId: 'device-a', hostname: 'host-a', count: 3 }] }),
      correlationRow({ id: 'corr-2', affectedDevices: [{ deviceId: 'device-a', hostname: 'host-a', count: 2 }, { deviceId: 'device-c', hostname: 'host-c', count: 1 }] }),
    ], eligibleDevices('device-a', 'device-c')];

    const result = await produceLogCorrelationFindings(ORG_ID);

    expect(result).toHaveLength(1);
    const deviceA = result[0]!.members.find((m) => m.deviceId === 'device-a')!;
    expect(deviceA.memberEvidence).toMatchObject({ count: 5 });
    expect(result[0]!.members.map((m) => m.deviceId).sort()).toEqual(['device-a', 'device-c']);
  });

  it('drops affected_devices entries for devices that are not eligible', async () => {
    // `affected_devices` is a jsonb snapshot with no FK, so it can name an
    // ephemeral, decommissioned OR already-deleted device. Only device-a comes
    // back from the eligibility lookup.
    dbMocks.state.queue = [[correlationRow()], eligibleDevices('device-a')];

    const result = await produceLogCorrelationFindings(ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.members.map((m) => m.deviceId)).toEqual(['device-a']);
    // device_count is written from members.length, so the evidence preview and
    // the summary must agree with the filtered set, not the raw snapshot.
    expect(result[0]!.evidence).toMatchObject({ totalDevices: 1 });
    expect(result[0]!.summary).toContain('1 devices');
  });

  it('produces no candidate when every affected device is ineligible', async () => {
    dbMocks.state.queue = [[correlationRow()], eligibleDevices()];
    const result = await produceLogCorrelationFindings(ORG_ID);
    expect(result).toEqual([]);
  });

  it('scopes the eligibility lookup to this org, excluding ephemeral and decommissioned devices', async () => {
    dbMocks.state.queue = [[correlationRow()], eligibleDevices('device-a', 'device-b')];

    await produceLogCorrelationFindings(ORG_ID);

    expect(drizzleSpies.eq).toHaveBeenCalledWith(devices.orgId, ORG_ID);
    expect(drizzleSpies.eq).toHaveBeenCalledWith(devices.isEphemeral, false);
    expect(drizzleSpies.ne).toHaveBeenCalledWith(devices.status, 'decommissioned');
  });

  it('skips the eligibility lookup entirely when there are no active correlations', async () => {
    dbMocks.state.queue = [[]];
    const result = await produceLogCorrelationFindings(ORG_ID);
    expect(result).toEqual([]);
    expect(dbMocks.select).toHaveBeenCalledTimes(1);
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

  it('filters out ephemeral and decommissioned devices via the join predicates', async () => {
    dbMocks.state.queue = [[reliabilityRow()]];
    await produceReliabilityOffenders(ORG_ID);
    expect(drizzleSpies.eq).toHaveBeenCalledWith(devices.isEphemeral, false);
    expect(drizzleSpies.ne).toHaveBeenCalledWith(devices.status, 'decommissioned');
    expect(drizzleSpies.lt).toHaveBeenCalledWith(deviceReliability.reliabilityScore, 50);
  });
});
