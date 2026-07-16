import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...args) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceVulnerabilities: {
    table: 'deviceVulnerabilities',
    deviceId: 'deviceVulnerabilities.deviceId',
    vulnerabilityId: 'deviceVulnerabilities.vulnerabilityId',
    status: 'deviceVulnerabilities.status',
  },
  vulnerabilities: {
    table: 'vulnerabilities',
    id: 'vulnerabilities.id',
    severity: 'vulnerabilities.severity',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, vulnerabilities } from '../db/schema';
import {
  aggregateVulnerabilityCounts,
  loadOpenVulnerabilityCounts,
} from './securityComplianceReportVulnerabilities';

beforeEach(() => vi.clearAllMocks());

describe('aggregateVulnerabilityCounts', () => {
  it('normalizes source severity casing and counts findings per device', () => {
    const counts = aggregateVulnerabilityCounts(
      [
        { deviceId: 'd1', vulnerabilityId: 'v1' },
        { deviceId: 'd1', vulnerabilityId: 'v2' },
        { deviceId: 'd2', vulnerabilityId: 'v3' },
        { deviceId: 'd2', vulnerabilityId: 'v4' },
      ],
      [
        { id: 'v1', severity: 'HIGH' },
        { id: 'v2', severity: 'Critical' },
        { id: 'v3', severity: 'High' },
        { id: 'v4', severity: 'CRITICAL' },
      ],
    );

    expect(counts.get('d1')).toEqual({ high: 1, critical: 1 });
    expect(counts.get('d2')).toEqual({ high: 1, critical: 1 });
  });

  it('fails instead of publishing zeroes when referenced catalog rows are missing', () => {
    expect(() =>
      aggregateVulnerabilityCounts(
        [{ deviceId: 'd1', vulnerabilityId: 'missing' }],
        [],
      ),
    ).toThrow('Vulnerability catalog lookup incomplete');
  });
});

describe('loadOpenVulnerabilityCounts', () => {
  it('reads an over-batch catalog in bounded selects within one system context', async () => {
    const vulnerabilityIds = Array.from(
      { length: 10_001 },
      (_, index) => `vulnerability-${index}`,
    );
    const findings = vulnerabilityIds.map((vulnerabilityId) => ({
      deviceId: 'device-1',
      vulnerabilityId,
    }));
    const catalogBatches: unknown[][] = [];

    selectMock.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: (predicate: { values?: unknown[] }) => {
          if (table === deviceVulnerabilities) return Promise.resolve(findings);
          expect(table).toBe(vulnerabilities);
          const batch = predicate.values ?? [];
          catalogBatches.push(batch);
          return Promise.resolve(
            batch.map((id) => ({ id: String(id), severity: 'HIGH' })),
          );
        },
      }),
    }));

    const counts = await loadOpenVulnerabilityCounts(['device-1']);

    expect(catalogBatches).toHaveLength(2);
    expect(catalogBatches.map((batch) => batch.length)).toEqual([10_000, 1]);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(counts.get('device-1')).toEqual({ high: 10_001, critical: 0 });
  });

  it('returns an empty map without querying or changing context for empty input', async () => {
    await expect(loadOpenVulnerabilityCounts([])).resolves.toEqual(new Map());
    expect(selectMock).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
