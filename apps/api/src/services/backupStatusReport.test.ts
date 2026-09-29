import { beforeEach, describe, expect, it, vi } from 'vitest';

// Two independent mocks: `db` for the org-name lookup (Drizzle chain, same
// pattern as hardwareLifecycleReport.test.ts), and `./backupHealthReadModel`
// for the W03 read model itself — mocking the read model directly (rather
// than trying to guess its internal query shape) keeps this test correct
// regardless of how W03 implements `listBackupHealthRows`/`summarizeBackupHealth`.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('./backupHealthReadModel', () => ({
  listBackupHealthRows: vi.fn(),
  summarizeBackupHealth: vi.fn(),
}));

import { db } from '../db';
import { listBackupHealthRows, summarizeBackupHealth } from './backupHealthReadModel';
import { generateBackupStatusReport } from './backupStatusReport';
import type { OrgReportExecutionAuthority } from './siteScope';
import type { ReportResult } from './reportGenerationService';
import type { BackupHealthRow, BackupHealthSummary, BackupStatusReportData } from '@breeze/shared';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function authority(
  kind: 'unrestricted' | 'restricted' = 'unrestricted',
  siteIds: string[] = [],
): OrgReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG_ID, siteIds }
      : { version: 1, kind, orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-15T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

function queueOrgSelect(rows: unknown[]) {
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit']) chain[method] = () => chain;
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

function row(overrides: Partial<BackupHealthRow> = {}): BackupHealthRow {
  return {
    key: 'breeze:d1',
    source: 'breeze',
    providerKey: null,
    providerLabel: null,
    orgId: ORG_ID,
    orgName: 'Acme Legal',
    siteId: null,
    deviceId: 'd1',
    name: 'WKS-1',
    computerName: 'WKS-1',
    osType: 'workstation',
    accountType: 'endpoint',
    status: 'completed',
    health: 'healthy',
    recency: 'under_24h',
    covered: true,
    stale: false,
    lastSuccessAt: '2026-09-15T02:00:00.000Z',
    lastSessionAt: '2026-09-15T02:00:00.000Z',
    selectedBytes: 1000,
    usedBytes: 900,
    errorsCount: 0,
    dataSources: ['files'],
    history28d: [],
    agentOnline: true,
    ...overrides,
  } as BackupHealthRow;
}

function summary(overrides: Partial<BackupHealthSummary> = {}): BackupHealthSummary {
  return {
    endpoints: { total: 1, covered: 1, uncovered: 0 },
    providerOnly: 0,
    m365Accounts: 0,
    byStatus: {
      completed: 1, completed_with_errors: 0, failed: 0, in_progress: 0,
      interrupted: 0, over_quota: 0, no_selection: 0, not_started: 0,
      no_backups: 0, unknown: 0,
    },
    byHealth: { healthy: 1, warning: 0, critical: 0, unknown: 0 },
    byRecency: { under_24h: 1, under_48h: 0, over_48h: 0, never: 0 },
    ...overrides,
  } as BackupHealthSummary;
}

function summaryOf(result: ReportResult): BackupStatusReportData {
  return result.summary as BackupStatusReportData;
}

describe('generateBackupStatusReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pages through the read model until nextCursor is null and sorts unhealthy first', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const healthy = row({ key: 'breeze:d1', name: 'WKS-1', status: 'completed', health: 'healthy', recency: 'under_24h' });
    const critical = row({ key: 'provider:p1', source: 'provider', name: 'SRV-1', status: 'failed', health: 'critical', recency: 'over_48h', covered: false });
    vi.mocked(listBackupHealthRows)
      .mockResolvedValueOnce({ rows: [healthy], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ rows: [critical], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 2, covered: 1, uncovered: 1 } }));

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(listBackupHealthRows).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listBackupHealthRows).mock.calls[1]![1]).toMatchObject({ page: { limit: 500, cursor: 'cursor-1' } });
    const data = summaryOf(result);
    expect(data.rows.map((r) => r.key)).toEqual(['provider:p1', 'breeze:d1']);
    expect(data.org).toEqual({ id: ORG_ID, name: 'Acme Legal' });
  });

  it('buckets statuses using the shared bucketForBackupStatus mapping, folding not_started and unknown into "other"', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [
      row({ key: 'a', status: 'not_started' }),
      row({ key: 'b', status: 'no_backups' }),
      row({ key: 'c', status: 'unknown' }),
      row({ key: 'd', status: 'failed' }),
    ];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const buckets = summaryOf(result).statusBuckets;
    expect(buckets.find((b) => b.key === 'no_backups')!.count).toBe(1);
    expect(buckets.find((b) => b.key === 'unsuccessful')!.count).toBe(1);
    expect(buckets.find((b) => b.key === 'other')!.count).toBe(2); // not_started + unknown
    expect(buckets.map((b) => b.key)).toEqual(['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful', 'other']);
  });

  it('omits the "other" bucket entirely when its count is zero, unlike the other five buckets which always appear', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [row({ key: 'a', status: 'completed' }), row({ key: 'b', status: 'failed' })];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const buckets = summaryOf(result).statusBuckets;
    expect(buckets.map((b) => b.key)).toEqual(['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful']);
    expect(buckets.some((b) => b.key === 'other')).toBe(false);
    // The always-present buckets appear at count 0 too — only "other" is special-cased.
    expect(buckets.find((b) => b.key === 'no_backups')!.count).toBe(0);
  });

  it('computes bucket percentages rounded to one decimal', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [row({ key: 'a', status: 'completed' }), row({ key: 'b', status: 'completed' }), row({ key: 'c', status: 'failed' })];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const completed = summaryOf(result).statusBuckets.find((b) => b.key === 'completed')!;
    expect(completed.count).toBe(2);
    expect(completed.pct).toBeCloseTo(66.7, 1);
  });

  it('buckets recency in the spec’s literal display order and counts correctly', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [
      row({ key: 'a', recency: 'never' }),
      row({ key: 'b', recency: 'under_24h' }),
      row({ key: 'c', recency: 'under_48h' }),
      row({ key: 'd', recency: 'over_48h' }),
      row({ key: 'e', recency: 'over_48h' }),
    ];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const buckets = summaryOf(result).recencyBuckets;
    expect(buckets.map((b) => b.key)).toEqual(['never', 'under_24h', 'under_48h', 'over_48h']);
    expect(buckets.find((b) => b.key === 'over_48h')!.count).toBe(2);
  });

  it('defaults includeDevicesWithoutBackup to true and passes onlyWithBackup: false to the read model', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![1]).toMatchObject({ onlyWithBackup: false, sources: ['breeze', 'provider'] });
  });

  it('includeDevicesWithoutBackup: false sends onlyWithBackup: true, and a narrowed sources list forwards verbatim', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, { includeDevicesWithoutBackup: false, sources: ['provider'] }, authority('unrestricted'));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![1]).toMatchObject({ onlyWithBackup: true, sources: ['provider'] });
  });

  it('an empty restrictedScope.siteIds short-circuits without querying the read model or the database', async () => {
    const result = await generateBackupStatusReport(ORG_ID, {}, authority('restricted', []));

    expect(db.select).not.toHaveBeenCalled();
    expect(listBackupHealthRows).not.toHaveBeenCalled();
    expect(summarizeBackupHealth).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(summaryOf(result).org).toEqual({ id: ORG_ID, name: '' });
    expect(summaryOf(result).statusBuckets.every((b) => b.count === 0)).toBe(true);
    // "other" is omitted at count 0 even in the empty-scope shortcut.
    expect(summaryOf(result).statusBuckets.map((b) => b.key)).toEqual(['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful']);
    expect(summaryOf(result).recencyBuckets.every((b) => b.count === 0)).toBe(true);
    expect(summaryOf(result).summary.endpoints).toEqual({ total: 0, covered: 0, uncovered: 0 });
  });

  it('a restricted scope with sites forwards restrictedScope.siteIds to the read model when config.sites is empty', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, {}, authority('restricted', [SITE_A]));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID], siteIds: [SITE_A] });
  });

  it('config.sites overrides the authority site restriction when explicitly narrower', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, { sites: [SITE_B] }, authority('restricted', [SITE_A, SITE_B]));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID], siteIds: [SITE_B] });
  });

  it('an unrestricted authority with no config.sites omits siteIds entirely', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID] });
  });

  it('projects a flat, spreadsheet-safe row for ReportResult.rows — dataSources joined, history28d omitted', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const r = row({ key: 'a', dataSources: ['files', 'mssql'], history28d: [{ day: '2026-09-14', status: 'completed' }] });
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [r], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(result.rows).toEqual([
      expect.objectContaining({ dataSources: 'files; mssql', device: 'WKS-1' }),
    ]);
    expect(Object.keys(result.rows![0] as object)).not.toContain('history28d');
  });

  it('stops at exactly MAX_ROWS (20k) and flags truncated when the read model keeps returning full pages', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    let n = 0;
    vi.mocked(listBackupHealthRows).mockImplementation(async () => ({
      rows: Array.from({ length: 500 }, () => row({ key: `x-${n++}` })),
      nextCursor: 'more',
    }));
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(summaryOf(result).rows.length).toBe(20_000);
    expect(summaryOf(result).truncated).toBe(true);
  });

  it('does not flag truncated when the final page ends the feed', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [row()], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));
    expect(summaryOf(result).truncated).toBe(false);
  });

  it('forwards the same filters to summarizeBackupHealth as to the row list', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    await generateBackupStatusReport(
      ORG_ID, { includeDevicesWithoutBackup: false, sources: ['provider'] }, authority('unrestricted'),
    );

    expect(summarizeBackupHealth).toHaveBeenCalledWith(
      { orgIds: [ORG_ID] },
      expect.objectContaining({ onlyWithBackup: true, sources: ['provider'] }),
    );
  });

  it('an unrestricted authority narrowing to config.sites forwards exactly those sites', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    await generateBackupStatusReport(ORG_ID, { sites: [SITE_B] }, authority('unrestricted'));
    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID], siteIds: [SITE_B] });
  });

  it('caps pagination at MAX_ROWS instead of looping forever on a read model that never stops', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockImplementation(async () => ({
      rows: [row({ key: `x-${Math.random()}` })],
      nextCursor: 'always-more',
    }));
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(summaryOf(result).rows.length).toBeLessThanOrEqual(20_000);
    expect(summaryOf(result).truncated).toBe(true);
    expect(vi.mocked(listBackupHealthRows).mock.calls.length).toBeLessThan(45); // ceil(20000/500) + 1
  });
});
