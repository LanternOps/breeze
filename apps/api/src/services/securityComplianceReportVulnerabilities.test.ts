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
    riskScore: 'deviceVulnerabilities.riskScore',
    acceptedBy: 'deviceVulnerabilities.acceptedBy',
    acceptedUntil: 'deviceVulnerabilities.acceptedUntil',
    resolvedAt: 'deviceVulnerabilities.resolvedAt',
  },
  vulnerabilities: {
    table: 'vulnerabilities',
    id: 'vulnerabilities.id',
    cveId: 'vulnerabilities.cveId',
    description: 'vulnerabilities.description',
    severity: 'vulnerabilities.severity',
    knownExploited: 'vulnerabilities.knownExploited',
    epssScore: 'vulnerabilities.epssScore',
    patchAvailable: 'vulnerabilities.patchAvailable',
  },
  vulnerabilitySources: {
    table: 'vulnerabilitySources',
    source: 'vulnerabilitySources.source',
    lastSuccessfulSyncAt: 'vulnerabilitySources.lastSuccessfulSyncAt',
    lastSyncStatus: 'vulnerabilitySources.lastSyncStatus',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, vulnerabilities, vulnerabilitySources } from '../db/schema';
import {
  aggregateVulnerabilityCounts,
  loadFeedFreshness,
  loadOpenFindings,
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

  it('treats a catalog entry mapped to unknown severity as contributing no counts', () => {
    const counts = aggregateVulnerabilityCounts(
      [{ deviceId: 'd1', vulnerabilityId: 'missing' }],
      [{ id: 'missing', severity: 'unknown' }],
    );

    expect(counts.get('d1')).toBeUndefined();
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

  it('propagates the catalog-incomplete failure end to end when a referenced row is missing from the catalog table', async () => {
    const findings = [{ deviceId: 'device-1', vulnerabilityId: 'vuln-missing' }];

    selectMock.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: (predicate: { values?: unknown[] }) => {
          if (table === deviceVulnerabilities) return Promise.resolve(findings);
          expect(table).toBe(vulnerabilities);
          // Catalog table has no row for 'vuln-missing' — simulates the row
          // being unreadable (e.g. an org-context RLS bypass returning zero rows).
          return Promise.resolve([]);
        },
      }),
    }));

    await expect(loadOpenVulnerabilityCounts(['device-1']))
      .rejects.toThrow('Vulnerability catalog lookup incomplete');
  });

  it('returns an empty map without querying or changing context for empty input', async () => {
    await expect(loadOpenVulnerabilityCounts([])).resolves.toEqual(new Map());
    expect(selectMock).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});


/**
 * #5784 W04. The vulnerability DETAIL artifact reads through the SAME module as
 * the posture control line: a second copy of the catalog join is how the two
 * surfaces start reporting different numbers for the same org.
 */
describe('loadOpenFindings', () => {
  it('returns an empty array for no device ids without touching the database', async () => {
    await expect(loadOpenFindings([])).resolves.toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('throws rather than undercounting when the catalog lookup is incomplete', async () => {
    selectMock.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === deviceVulnerabilities) {
            return Promise.resolve([
              { deviceId: 'd1', vulnerabilityId: 'v-missing', status: 'open', riskScore: '10', acceptedBy: null, acceptedUntil: null, resolvedAt: null },
            ]);
          }
          return Promise.resolve([]);
        },
      }),
    }));

    await expect(loadOpenFindings(['d1'])).rejects.toThrow(/catalog lookup incomplete/i);
  });

  it('carries KEV and EPSS through so the caller can rank on exploitation, not only severity', async () => {
    selectMock.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === deviceVulnerabilities) {
            return Promise.resolve([
              { deviceId: 'd1', vulnerabilityId: 'v1', status: 'open', riskScore: '70.00', acceptedBy: null, acceptedUntil: null, resolvedAt: null },
            ]);
          }
          expect(table).toBe(vulnerabilities);
          return Promise.resolve([
            { id: 'v1', cveId: 'CVE-2026-1', description: 'boom', severity: 'MEDIUM', knownExploited: true, epssScore: '0.9400', patchAvailable: true },
          ]);
        },
      }),
    }));

    const got = await loadOpenFindings(['d1']);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      cveId: 'CVE-2026-1',
      severity: 'medium',
      knownExploited: true,
      epssScore: 0.94,
      riskScore: 70,
      patchAvailable: true,
      deviceId: 'd1',
      status: 'open',
    });
  });

  it('reads the requested statuses, not only open findings', async () => {
    const captured: Array<{ op: string; value?: unknown; values?: unknown[] }> = [];
    selectMock.mockImplementation(() => ({
      from: (table: unknown) => ({
        where: (predicate: { conditions?: Array<{ op: string; column: unknown; value?: unknown; values?: unknown[] }> }) => {
          if (table === deviceVulnerabilities) {
            for (const condition of predicate.conditions ?? []) {
              if (condition.column === deviceVulnerabilities.status) captured.push(condition);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        },
      }),
    }));

    await loadOpenFindings(['d1'], { statuses: ['accepted', 'mitigated'] });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ op: 'inArray', values: ['accepted', 'mitigated'] });
  });
});

describe('loadFeedFreshness', () => {
  it('reports a never-synced source as lastSyncAt null, never as fresh', async () => {
    selectMock.mockImplementation(() => ({
      from: (table: unknown) => {
        expect(table).toBe(vulnerabilitySources);
        return Promise.resolve([
          { source: 'msrc', lastSuccessfulSyncAt: null, lastSyncStatus: null },
          { source: 'nvd', lastSuccessfulSyncAt: new Date('2026-09-15T00:00:00.000Z'), lastSyncStatus: 'success' },
        ]);
      },
    }));

    const feeds = await loadFeedFreshness();
    expect(feeds.find((f) => f.name === 'msrc')?.lastSyncAt).toBeNull();
    expect(feeds.find((f) => f.name === 'nvd')?.lastSyncAt).toBe('2026-09-15T00:00:00.000Z');
  });
});
