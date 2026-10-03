import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { BackupHealthRow } from '../types/backupHealth';
import type { BackupStatusReportData } from '../types/backupStatusReport';

const opts = { reportType: 'backup_status', generatedAt: 'Sep 15, 2026', timezone: 'UTC' };

// See reportPdf.test.ts for why this range is remapped: jsPDF's default font
// encodes text as WinAnsi (cp1252), which diverges from plain Latin-1 only in
// the 0x80-0x9F byte range. None of this file's own prose uses a character in
// that range (plain ASCII apostrophes/hyphens throughout), but the helper is
// copied verbatim for consistency with every sibling report PDF test and as a
// safety net against jsPDF's own default punctuation (e.g. an em dash in a
// generated label) landing in that range.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[-]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

function row(partial: Partial<BackupHealthRow> & { key: string; name: string }): BackupHealthRow {
  return {
    source: 'breeze', providerKey: null, providerLabel: null, orgId: 'o1', orgName: 'Acme Legal',
    siteId: null, deviceId: 'd1', computerName: null, osType: 'workstation', accountType: 'endpoint',
    status: 'completed', health: 'healthy', recency: 'under_24h', covered: true, stale: false,
    lastSuccessAt: null, lastSessionAt: null, selectedBytes: null, usedBytes: null, errorsCount: 0,
    dataSources: [], history28d: [], agentOnline: null,
    ...partial,
  } as BackupHealthRow;
}

const data: BackupStatusReportData = {
  org: { id: 'o1', name: 'Harlow & Pierce P.C.' },
  asOf: '2026-09-15T12:00:00.000Z',
  generatedAt: '2026-09-15T12:00:00.000Z',
  summary: {
    endpoints: { total: 3, covered: 1, uncovered: 2 },
    providerOnly: 1,
    m365Accounts: 0,
    byStatus: {
      completed: 1, completed_with_errors: 0, failed: 1, in_progress: 0,
      interrupted: 0, over_quota: 0, no_selection: 0, not_started: 1,
      no_backups: 0, unknown: 0,
    },
    byHealth: { healthy: 1, warning: 0, critical: 1, unknown: 1 },
    byRecency: { under_24h: 1, under_48h: 0, over_48h: 1, never: 1 },
  } as BackupStatusReportData['summary'],
  // Six buckets, `in_progress` (not `in_process`) — the shared W01
  // `BACKUP_STATUS_BUCKET_IDS` order. `other` is present here because the
  // fixture includes a `not_started` row (folded into `other`); Task 4's
  // builder omits this bucket entirely when its count is zero.
  statusBuckets: [
    { key: 'no_backups', count: 0, pct: 0 },
    { key: 'completed', count: 1, pct: 33.3 },
    { key: 'completed_with_errors', count: 0, pct: 0 },
    { key: 'in_progress', count: 0, pct: 0 },
    { key: 'unsuccessful', count: 1, pct: 33.3 },
    { key: 'other', count: 1, pct: 33.4 },
  ],
  recencyBuckets: [
    { key: 'never', count: 1, pct: 33.3 },
    { key: 'under_24h', count: 1, pct: 33.3 },
    { key: 'under_48h', count: 0, pct: 0 },
    { key: 'over_48h', count: 1, pct: 33.4 },
  ],
  rows: [
    row({
      key: 'provider:p1', name: 'LAW-SRV', source: 'provider', providerLabel: 'Cove Data Protection',
      computerName: 'LAW-SRV', osType: 'server', status: 'failed', health: 'critical', recency: 'over_48h',
      covered: false, selectedBytes: 5_000_000_000, usedBytes: 4_800_000_000, errorsCount: 3,
      dataSources: ['files', 'mssql'],
      history28d: [{ day: '2026-09-13', status: 'failed' }, { day: '2026-09-14', status: 'failed' }],
    }),
    row({
      key: 'breeze:d2', name: 'WKS-2', computerName: 'WKS-2', status: 'not_started', health: 'unknown',
      recency: 'never', selectedBytes: null, usedBytes: null,
    }),
    row({
      key: 'breeze:d1', name: 'SAM4', computerName: 'SAM4', status: 'completed', health: 'healthy',
      recency: 'under_24h', selectedBytes: 100_000_000, usedBytes: 90_000_000,
    }),
  ],
  truncated: false,
  options: { includeDevicesWithoutBackup: true, sources: ['breeze', 'provider'] },
};

describe('backup status report PDF', () => {
  it('renders the title, both bucket bars and the device table', () => {
    const doc = buildReportPdf([], { ...opts, summary: data });
    const text = pdfText(doc);
    expect(text).toContain('Backup Status Report');
    expect(text).toContain('Harlow & Pierce P.C.');
    expect(text).toContain('Status');
    expect(text).toContain('Completed');
    expect(text).toContain('Unsuccessful');
    expect(text).toContain('Other');
    expect(text).toContain('Last successful backup');
    expect(text).toContain('Never');
    expect(text).toContain('Under 24 hours');
    expect(text).toContain('Over 48 hours');
    expect(text).toContain('LAW-SRV');
    expect(text).toContain('SAM4');
    expect(text).toContain('WKS-2');
    expect(text).toContain('Not started');
    expect(text).toContain('Cove Data Protection');
    expect(text).toContain('Breeze');
    expect(text).toContain('Failed');
    expect(text).toContain('Server');
    expect(text).toContain('Workstation');
    expect(text).toContain('BACKUP STATUS');
  });

  it('renders an empty snapshot without throwing', () => {
    const empty: BackupStatusReportData = {
      ...data,
      rows: [],
      statusBuckets: data.statusBuckets.map((b) => ({ ...b, count: 0, pct: 0 })),
      recencyBuckets: data.recencyBuckets.map((b) => ({ ...b, count: 0, pct: 0 })),
    };
    const doc = buildReportPdf([], { ...opts, summary: empty });
    const text = pdfText(doc);
    expect(text).toContain("No devices matched this report's scope and filters.");
  });

  it('paginates a large device list and keeps the chrome on every page', () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      row({ key: `d${i}`, name: `PC-${i}`, status: 'completed', health: 'healthy' }));
    const doc = buildReportPdf([], { ...opts, summary: { ...data, rows } });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const text = pdfText(doc);
    expect(text.match(/BACKUP STATUS/g)?.length).toBe(doc.getNumberOfPages());
  });

  it('prints a truncation note only when the row list was cut short', () => {
    const cut = pdfText(buildReportPdf([], { ...opts, summary: { ...data, truncated: true } }));
    expect(cut).toContain('Row limit reached');
    const full = pdfText(buildReportPdf([], { ...opts, summary: data }));
    expect(full).not.toContain('Row limit reached');
  });

  it('falls back to the generic table when the snapshot has no rows array', () => {
    const doc = buildReportPdf([{ hostname: 'x' }], {
      ...opts,
      summary: { org: { name: 'Acme' } } as unknown as BackupStatusReportData,
    });
    expect(pdfText(doc)).not.toContain('Backup Status Report');
  });
});
