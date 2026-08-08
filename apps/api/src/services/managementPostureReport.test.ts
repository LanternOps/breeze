import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from '../db';
import {
  MANAGEMENT_POSTURE_CATEGORIES,
  getManagementPostureSummary,
  getPostureDetections,
  getPostureCoverage,
  getPostureDevices,
  isManagementPostureCategory,
} from './managementPostureReport';

const executeMock = vi.mocked(db.execute);

/** Serialize a drizzle SQL tree (safely, despite cycles) so tests can assert
 *  structural properties of the generated SQL. */
function sqlToString(node: unknown): string {
  const seen = new Set<object>();
  return JSON.stringify(node, (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

beforeEach(() => {
  executeMock.mockReset();
});

describe('isManagementPostureCategory', () => {
  it('accepts every ingest category and rejects everything else', () => {
    for (const c of MANAGEMENT_POSTURE_CATEGORIES) {
      expect(isManagementPostureCategory(c)).toBe(true);
    }
    expect(isManagementPostureCategory('rmm; DROP TABLE devices')).toBe(false);
    expect(isManagementPostureCategory('')).toBe(false);
  });
});

describe('getManagementPostureSummary', () => {
  it('issues TWO separate queries — detections (lateral) and coverage (no lateral)', async () => {
    executeMock.mockResolvedValue([] as never);

    await getManagementPostureSummary({ category: 'rmm', stalenessDays: 7, scope: undefined });

    expect(executeMock).toHaveBeenCalledTimes(2);
    const first = sqlToString(executeMock.mock.calls[0]![0]);
    const second = sqlToString(executeMock.mock.calls[1]![0]);

    // Query (a): detections explode the category array via CROSS JOIN LATERAL.
    expect(first).toContain('CROSS JOIN LATERAL');
    expect(first).toContain('count(DISTINCT');
    // Never a LEFT JOIN — the collapsed one-query form this design forbids.
    expect(first).not.toContain('LEFT JOIN');

    // Query (b): coverage denominators computed WITHOUT any lateral join, and
    // never-scanned split from scanned-none-detected.
    expect(second).not.toContain('JOIN');
    expect(second).toContain('never_scanned');
    expect(second).toContain('scanned_none_detected');
  });

  it('scopes both queries with the caller-supplied conditions', async () => {
    executeMock.mockResolvedValue([] as never);

    await getManagementPostureSummary({
      category: 'rmm',
      stalenessDays: 7,
      scope: sql`SCOPE_SENTINEL`,
    });

    for (const call of executeMock.mock.calls) {
      expect(sqlToString(call[0])).toContain('SCOPE_SENTINEL');
    }
  });

  it('assembles per-org products under their coverage denominators, plus totals', async () => {
    executeMock
      .mockResolvedValueOnce([
        { org_id: 'org-1', product: 'Datto RMM', status: 'active', device_count: 3, fresh_device_count: 2 },
        { org_id: 'org-1', product: 'Datto RMM', status: 'installed', device_count: 1, fresh_device_count: 1 },
        { org_id: 'org-2', product: 'NinjaOne', status: 'unknown', device_count: 2, fresh_device_count: 0 },
      ] as never)
      .mockResolvedValueOnce([
        { org_id: 'org-1', total_devices: 10, never_scanned: 2, stale: 1, scanned_none_detected: 4, detected_devices: 4, fresh_detected_devices: 3 },
        { org_id: 'org-2', total_devices: 5, never_scanned: 0, stale: 2, scanned_none_detected: 3, detected_devices: 2, fresh_detected_devices: 0 },
        { org_id: 'org-3', total_devices: 4, never_scanned: 4, stale: 0, scanned_none_detected: 0, detected_devices: 0, fresh_detected_devices: 0 },
      ] as never);

    const summary = await getManagementPostureSummary({ category: 'rmm', stalenessDays: 7, scope: undefined });

    expect(summary.category).toBe('rmm');
    expect(summary.stalenessDays).toBe(7);
    expect(summary.orgs).toHaveLength(3);

    const org1 = summary.orgs.find((o) => o.orgId === 'org-1')!;
    expect(org1.products).toEqual([
      { product: 'Datto RMM', status: 'active', deviceCount: 3, freshDeviceCount: 2 },
      { product: 'Datto RMM', status: 'installed', deviceCount: 1, freshDeviceCount: 1 },
    ]);
    expect(org1.neverScanned).toBe(2);

    // 'unknown' detections are neither dropped nor merged into another status.
    const org2 = summary.orgs.find((o) => o.orgId === 'org-2')!;
    expect(org2.products).toEqual([
      { product: 'NinjaOne', status: 'unknown', deviceCount: 2, freshDeviceCount: 0 },
    ]);

    // An org with zero detections still appears WITH its denominators — a
    // never-scanned fleet must never vanish from the report.
    const org3 = summary.orgs.find((o) => o.orgId === 'org-3')!;
    expect(org3.products).toEqual([]);
    expect(org3.neverScanned).toBe(4);

    expect(summary.totals).toEqual({
      totalDevices: 19,
      neverScanned: 6,
      stale: 3,
      scannedNoneDetected: 7,
      detectedDevices: 6,
      freshDetectedDevices: 3,
    });
  });

  it('throws (rather than silently dropping) if a detection has no coverage row', async () => {
    executeMock
      .mockResolvedValueOnce([
        { org_id: 'org-ghost', product: 'Atera', status: 'active', device_count: 1, fresh_device_count: 1 },
      ] as never)
      .mockResolvedValueOnce([] as never);

    await expect(
      getManagementPostureSummary({ category: 'rmm', stalenessDays: 7, scope: undefined })
    ).rejects.toThrow(/coverage row/);
  });
});

describe('getPostureDetections', () => {
  it('coerces counts to numbers and passes category + staleness as bind params', async () => {
    executeMock.mockResolvedValueOnce([
      { org_id: 'org-1', product: 'Level', status: 'active', device_count: '4', fresh_device_count: '1' },
    ] as never);

    const rows = await getPostureDetections({ category: 'remoteAccess', stalenessDays: 30, scope: undefined });

    expect(rows).toEqual([
      { orgId: 'org-1', product: 'Level', status: 'active', deviceCount: 4, freshDeviceCount: 1 },
    ]);
    const q = sqlToString(executeMock.mock.calls[0]![0]);
    expect(q).toContain('remoteAccess');
    expect(q).toContain('30');
    // Category rides a bind param (with a cast), never string interpolation.
    expect(q).not.toContain("'remoteAccess'");
  });
});

describe('getPostureCoverage', () => {
  it('classifies never-scanned separately from scanned-none-detected', async () => {
    executeMock.mockResolvedValueOnce([
      { org_id: 'org-1', total_devices: '6', never_scanned: '1', stale: '1', scanned_none_detected: '2', detected_devices: '2', fresh_detected_devices: '2' },
    ] as never);

    const rows = await getPostureCoverage({ category: 'rmm', stalenessDays: 7, scope: undefined });

    expect(rows).toEqual([
      {
        orgId: 'org-1', totalDevices: 6, neverScanned: 1, stale: 1,
        scannedNoneDetected: 2, detectedDevices: 2, freshDetectedDevices: 2,
      },
    ]);
    const q = sqlToString(executeMock.mock.calls[0]![0]);
    expect(q).toContain('IS NULL');
    expect(q).toContain('IS NOT NULL');
  });
});

describe('getPostureDevices', () => {
  it('returns total + mapped device rows and filters on the product bind param', async () => {
    executeMock
      .mockResolvedValueOnce([{ total: '2' }] as never)
      .mockResolvedValueOnce([
        {
          id: 'dev-1', org_id: 'org-1', site_id: 'site-1', hostname: 'PC-01',
          display_name: null, status: 'online', os_type: 'windows',
          last_seen_at: new Date('2026-08-01T00:00:00Z'),
          collected_at: '2026-08-07T12:00:00Z',
          detection_status: 'active', detection_version: '1.2.3',
        },
      ] as never);

    const result = await getPostureDevices({
      category: 'rmm', stalenessDays: 7, scope: undefined,
      product: 'ScreenConnect', detectionStatus: 'active', limit: 50, offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.devices).toEqual([
      {
        id: 'dev-1', orgId: 'org-1', siteId: 'site-1', hostname: 'PC-01',
        displayName: null, status: 'online', osType: 'windows',
        lastSeenAt: '2026-08-01T00:00:00.000Z',
        collectedAt: '2026-08-07T12:00:00Z',
        detectionStatus: 'active', detectionVersion: '1.2.3',
      },
    ]);
    for (const call of executeMock.mock.calls) {
      expect(sqlToString(call[0])).toContain('ScreenConnect');
    }
  });
});
