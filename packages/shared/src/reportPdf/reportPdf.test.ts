import { describe, expect, it } from 'vitest';
import { buildPostureBackupMetric, buildReportPdf } from './reportPdf';
import type { PostureSummary } from '../types/postureReport';
import type { ExecutiveSummary } from '../types/executiveSummaryReport';

const postureSummary: PostureSummary = {
  org: { id: 'o1', name: 'Acme Corp' },
  deviceCount: 2,
  postureScore: 79,
  controls: { edrCoveragePct: 50, anyAvCoveragePct: 100, unprotectedCount: 0, encryptionPct: 50, firewallPct: 100, patchCurrentPct: 50 },
  privilegedAccess: { uacInterceptionEnabled: true, activePamRules: 1 },
  securityProducts: [{ product: 'Defender', category: 'edr', active: true }],
};
const postureRows = [
  { hostname: 'PC-1', os: 'windows', site: 'HQ', protection: 'Defender', firewall: true, encryption: 'Encrypted', pendingPatches: 0, criticalPatches: 0, openVulnHigh: 0, openVulnCritical: 0, protectionManaged: true },
  { hostname: 'PC-2', os: 'macos', site: 'HQ', protection: 'No data', firewall: false, encryption: 'Unencrypted', pendingPatches: 3, criticalPatches: 1, openVulnHigh: 2, openVulnCritical: 0, protectionManaged: false },
];
const execSummary: ExecutiveSummary = {
  org: { id: 'o1', name: 'Acme Corp' },
  devices: { total: 42, online: 39, offline: 3, healthPercentage: 93 },
  alerts: { total: 18, critical: 2, high: 5, resolved: 12, resolutionRate: 67 },
  osDistribution: { windows: 30, macos: 10, linux: 2 },
  siteBreakdown: [
    { site: 'HQ', count: 25 },
    { site: 'Warehouse', count: 12 },
    { site: 'Remote', count: 5 },
  ],
};
const opts = { generatedAt: 'Jul 1, 2026, 9:00 AM', timezone: 'UTC' };

// jsPDF encodes standard-font text as WinAnsi (cp1252) bytes, which surface in
// the page command strings as raw 0x80-0x9f characters — an em-dash arrives as
// \x97, not "—". That range is the only place cp1252 diverges from latin1, so
// mapping it back lets the assertions below match the typography a reader
// actually sees. Without it, `toContain('— 1 device')` fails and the tempting
// "fix" is to downgrade the PDF's punctuation to ASCII to suit the test.
const CP1252_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021' +
  '\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014' +
  '\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfCommandPages(doc: ReturnType<typeof buildReportPdf>): string[] {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((page): page is string[] => Array.isArray(page))
    .map((page) => decodeWinAnsi(page.join('\n')));
}

function pdfCommandText(doc: ReturnType<typeof buildReportPdf>): string {
  return pdfCommandPages(doc).join('\n');
}

describe('buildPostureBackupMetric', () => {
  it.each([false, true])(
    'renders optional backup neutrally when configured=%s',
    (backupConfigured) => {
      expect(buildPostureBackupMetric({
        backupRequired: false,
        backupConfigured,
      })).toEqual({
        label: 'Backup',
        value: backupConfigured ? 'Optional; configured' : 'Not required',
        status: 'neutral',
      });
    },
  );

  it.each([
    { backupConfigured: false, status: 'bad' },
    { backupConfigured: true, status: 'good' },
  ] as const)(
    'keeps legacy backup configured=$backupConfigured status=$status',
    ({ backupConfigured, status }) => {
      expect(buildPostureBackupMetric({ backupConfigured })).toEqual({
        label: 'Backup',
        value: backupConfigured ? 'Yes' : 'No',
        status,
      });
    },
  );
});

describe('buildReportPdf in Node (no DOM)', () => {
  it('renders the posture cover + device table', () => {
    const doc = buildReportPdf(postureRows, { ...opts, reportType: 'security_compliance_posture', summary: postureSummary });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(1000);
  });

  it('renders Huntress, SentinelOne, and Defender from the reference-like inventory', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      securityProducts: [
        { product: 'Huntress', category: 'mdr', active: true, deviceCoverage: 6 },
        { product: 'SentinelOne', category: 'edr', active: true, deviceCoverage: 4 },
        { product: 'Defender', category: 'antivirus', active: true, deviceCoverage: 4 },
      ],
    };
    const rowsWithoutProductNames = postureRows.map((row) => ({ ...row, protection: 'Device protection' }));
    const doc = buildReportPdf(rowsWithoutProductNames, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary,
    });
    const text = pdfCommandText(doc);
    expect(text).toContain('Huntress');
    expect(text).toContain('SentinelOne');
    expect(text).toContain('Defender');
    const pages = pdfCommandPages(doc);
    const continuationPage = pages.findIndex((page) => page.includes('Continued from the posture summary'));
    const detailPage = pages.findIndex((page) => page.includes('Per-device detail'));
    expect(continuationPage).toBeGreaterThan(0);
    expect(detailPage).toBeGreaterThan(continuationPage);
  });

  it('continues a large product inventory across multiple ordered pages with page chrome', () => {
    const products = Array.from({ length: 80 }, (_, index) => ({
      product: `Security Product [${String(index + 1).padStart(3, '0')}]`,
      category: 'antivirus' as const,
      active: true,
      deviceCoverage: index + 1,
    }));
    const doc = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary: { ...postureSummary, securityProducts: products },
    });
    const pages = pdfCommandPages(doc);
    const text = pdfCommandText(doc);
    for (const product of products) expect(text).toContain(product.product);
    const continuationPages = pages
      .map((page, pageIndex) => ({ page, pageIndex }))
      .filter(({ page }) => (
        page.includes('Security products in use')
        && page.includes('Continued from the posture summary')
      ));
    expect(continuationPages.length).toBeGreaterThanOrEqual(2);
    for (const { page } of continuationPages) {
      expect(page).toContain('SECURITY & COMPLIANCE POSTURE');
      expect(page).toContain('Generated by Breeze RMM');
      expect(page).toContain('Confidential');
    }
    const detailPage = pages.findIndex((page) => page.includes('Per-device detail'));
    expect(detailPage).toBeGreaterThan(continuationPages.at(-1)!.pageIndex);
    const inventoryPagesText = pages.slice(0, detailPage).join('\n');
    let previousProductIndex = -1;
    for (const product of products) {
      const productIndex = inventoryPagesText.indexOf(product.product);
      expect(productIndex).toBeGreaterThan(previousProductIndex);
      previousProductIndex = productIndex;
    }
    expect(text).toContain('continued');
    expect(text).toContain('Antivirus');
    expect(text).toContain(' — 1 device');
    expect(text).not.toContain(' — 1 devices');
  });

  it('renders optional missing backup neutrally and omits the backup recommendation', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      controls: {
        ...postureSummary.controls,
        backupRequired: false,
        backupConfigured: false,
      },
    };
    const text = pdfCommandText(buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary,
    }));
    expect(text).toContain('Not required');
    expect(text).not.toContain('Configure backups');
  });

  it('renders configured optional backup neutrally without removing the evidence', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      controls: {
        ...postureSummary.controls,
        backupRequired: false,
        backupConfigured: true,
      },
    };
    expect(pdfCommandText(buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary,
    }))).toContain('Optional; configured');
  });

  it('keeps missing backup required for legacy summaries', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      controls: { ...postureSummary.controls, backupConfigured: false },
    };
    expect(pdfCommandText(buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary,
    }))).toContain('Configure backups');
  });

  it('renders a generic table for row reports', () => {
    const doc = buildReportPdf([{ hostname: 'PC-1', status: 'online' }], { ...opts, reportType: 'device_inventory' });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('renders the executive summary cover from summary (no rows)', () => {
    const doc = buildReportPdf([], { ...opts, reportType: 'executive_summary', summary: execSummary });
    expect(doc.getNumberOfPages()).toBe(1);
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(2000);
    // The designed cover (scorecard + grids + actions) must render appreciably
    // more content than the bare "No data" fallback for the same report type.
    const fallback = buildReportPdf([], { ...opts, reportType: 'executive_summary' });
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(
      Buffer.from(fallback.output('arraybuffer')).byteLength,
    );
  });

  it('falls back to the generic empty page when an exec summary has no summary', () => {
    const doc = buildReportPdf([], { ...opts, reportType: 'executive_summary' });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('renders branded chrome with a partner name', () => {
    const doc = buildReportPdf([], { ...opts, reportType: 'compliance', branding: { name: 'Olive MSP', logoDataUrl: null, logoAspect: null } });
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(500);
  });

  it('renders a scorecard trend chip when a previous baseline is supplied', () => {
    const withTrend = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary: postureSummary,
      previous: { generatedAt: '2026-06-01T00:00:00Z', summary: { postureScore: 74 } },
    });
    expect(withTrend.getNumberOfPages()).toBeGreaterThanOrEqual(2);

    const withoutTrend = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary: postureSummary,
    });

    // The delta chip ("+5 since Jun 1") is extra drawn content, so the
    // trended render is strictly larger than the baseline-less one.
    expect(Buffer.from(withTrend.output('arraybuffer')).byteLength).toBeGreaterThan(
      Buffer.from(withoutTrend.output('arraybuffer')).byteLength,
    );
  });

  it('renders an executive-summary trend chip from previous.summary.devices.healthPercentage', () => {
    const withTrend = buildReportPdf([], {
      ...opts,
      reportType: 'executive_summary',
      summary: execSummary,
      previous: { generatedAt: '2026-06-01T00:00:00Z', summary: { devices: { healthPercentage: 88 } } },
    });
    const withoutTrend = buildReportPdf([], { ...opts, reportType: 'executive_summary', summary: execSummary });

    expect(Buffer.from(withTrend.output('arraybuffer')).byteLength).toBeGreaterThan(
      Buffer.from(withoutTrend.output('arraybuffer')).byteLength,
    );
  });

  it('omits the trend chip when the delta is zero or the previous summary lacks the metric', () => {
    // Same score as current: no chip drawn (delta === 0 is filtered out), so
    // byte size matches the no-previous render exactly.
    const sameScore = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary: postureSummary,
      previous: { generatedAt: '2026-06-01T00:00:00Z', summary: { postureScore: 79 } },
    });
    const noPrevious = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary: postureSummary,
    });
    expect(Buffer.from(sameScore.output('arraybuffer')).byteLength).toBe(
      Buffer.from(noPrevious.output('arraybuffer')).byteLength,
    );

    // Previous run captured a summary, but not this metric — no crash, no chip.
    const missingMetric = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary: postureSummary,
      previous: { generatedAt: '2026-06-01T00:00:00Z', summary: { unrelated: true } },
    });
    expect(Buffer.from(missingMetric.output('arraybuffer')).byteLength).toBe(
      Buffer.from(noPrevious.output('arraybuffer')).byteLength,
    );
  });
});
