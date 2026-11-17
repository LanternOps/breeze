/**
 * #12048 / #12041: the client reports generated for one org must read as one
 * family — the partner's page size, one date format, a timezone on the
 * generated time, one meta separator — and the partner logo sits on the header
 * once per page, without a white chip behind it.
 */
import { describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { deflateSync } from 'node:zlib';
import { buildReportPdf, executiveSummaryPeriodLabel, scorecardLayout, type BuildOpts, type ReportBranding } from './reportPdf';
import type { ExecutiveSummary, PostureSummary } from '../types';
import type { ThreatDetectionSummary } from '../types/threatDetectionReport';
import type { VulnerabilityManagementSummary } from '../types/vulnerabilityManagementReport';

type Doc = ReturnType<typeof buildReportPdf>;

const CP1252_HIGH =
  '€\u0081‚ƒ„…†‡' +
  'ˆ‰Š‹Œ\u008dŽ\u008f' +
  '\u0090‘’“”•–—' +
  '˜™š›œ\u009džŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

const pages = (doc: Doc): string[] =>
  ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')));
const text = (doc: Doc): string => pages(doc).join('\n');

/** Every page's MediaBox, in mm, from jsPDF's own page bookkeeping. */
function pageSizesMm(doc: Doc): Array<[number, number]> {
  const n = doc.getNumberOfPages();
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= n; i += 1) {
    doc.setPage(i);
    out.push([doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight()]);
  }
  return out;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A small RGBA PNG with transparent pixels — the issue's logo shape. */
function transparentPng(w = 40, h = 10): string {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    if (x < h) { raw[o] = 20; raw[o + 1] = 60; raw[o + 2] = 140; raw[o + 3] = 255; }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const exec: ExecutiveSummary = {
  org: { id: 'o1', name: 'Example Client' },
  devices: { total: 12, online: 9, offline: 3, healthPercentage: 75 },
  alerts: { total: 18, critical: 2, high: 5, resolved: 12, resolutionRate: 67 },
  osDistribution: { windows: 12 },
  siteBreakdown: [{ site: 'Main Office', count: 12 }],
  period: { start: '2026-10-10T17:06:00.000Z', end: '2026-11-09T17:06:00.000Z' },
};

const posture: PostureSummary = {
  org: { id: 'o1', name: 'Example Client' },
  deviceCount: 8,
  postureScore: 64,
  controls: {
    edrCoveragePct: 63, anyAvCoveragePct: 100, avDefinitionsCurrentPct: 100, encryptionPct: 100,
    firewallPct: 100, patchCurrentPct: 100, passwordComplexityPct: 0, localAdminExposurePct: 83,
    cisIncluded: false, identityProviderConnected: false, backupRequired: false, backupConfigured: false, dnsFilteringActive: false,
  },
};
const postureRow = (hostname: string) => ({
  hostname, site: 'Main Office', os: 'windows', protection: 'Windows Defender (RTP on)', protectionManaged: false,
  realTimeProtection: true, avDefinitionsAgeDays: 1, encryption: 'encrypted', firewall: true, localAdmins: 3,
  patchAssessed: true, pendingPatches: 2, criticalPatches: 0, openVulnCritical: 19, openVulnHigh: 5, cisPassRate: null, posture: null,
});

const threat: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: 'Example Client',
  generatedAt: '2026-11-09T17:06:00.000Z',
  coverage: {
    periodStart: '2026-10-10', periodEnd: '2026-11-09',
    coveredFrom: '2026-01-01T00:00:00.000Z', coveredTo: '2026-11-09T11:00:00.000Z',
    generatedAt: '2026-11-09T17:06:00.000Z', sourceStatus: 'ok',
    lastSyncAt: '2026-11-09T11:00:00.000Z', lastSyncStatus: 'ok',
    unattributableExcluded: 0, withheld: 0, note: '',
  },
  agentCoverage: {
    huntressAgents: 8, breezeDevices: 12, agentsOffline: 0, devicesWithoutAgent: 4,
    devicesWithDetectionAgent: 8, devicesWithoutDetectionAgent: 4, unmatchedAgents: 0,
  },
  incidents: {
    opened: 1, resolved: 1, bySeverity: { low: 1 }, byStatus: { resolved: 1 },
    meanResolveHours: 3, medianResolveHours: 3, carriedIn: 0,
  },
  rows: [{
    id: 'i1', reportedAt: '2026-10-20T14:00:00.000Z', hostname: 'WS-04', severity: 'low', category: 'identity',
    title: 'Suspicious sign-in', status: 'resolved', resolvedAt: '2026-10-20T17:00:00.000Z', recommendation: null,
  }],
  dataGaps: [],
};

const vuln: VulnerabilityManagementSummary = {
  orgId: 'o1',
  orgName: 'Example Client',
  generatedAt: '2026-11-09T17:06:00.000Z',
  period: { start: '2026-10-10', end: '2026-11-09', nextEnd: '2026-12-09' },
  feeds: [{ name: 'nvd', lastSyncAt: '2026-11-09T08:00:00.000Z', lastStatus: 'success', stale: false }],
  feedNote: '',
  open: { critical: 2, high: 5, medium: 9, low: 1, knownExploited: 1, highEpss: 2, epssThreshold: 0.5 },
  topRemediable: [{ cveId: 'CVE-2026-1111', severity: 'critical', knownExploited: true, epssScore: 0.94, riskScore: 92, patchAvailable: true, affectedDevices: 4, title: 'Remote code execution in Widget' }],
  withheld: 0,
  exceptions: [{ cveId: 'CVE-2026-2222', status: 'accepted', acceptedBy: 'Jo', acceptedUntil: '2026-11-20', expiringNextPeriod: true, affectedDevices: 2 }],
  closedThisPeriod: { count: 6, bySeverity: { critical: 1, high: 5 } },
  rows: [{ cveId: 'CVE-2026-1111', severity: 'critical', knownExploited: true, epssScore: 0.94, riskScore: 92, patchAvailable: true, affectedDevices: 4 }],
  dataGaps: [],
};

const REPORTS: Array<{ name: string; rows: unknown[]; opts: Pick<BuildOpts, 'reportType' | 'summary'> }> = [
  { name: 'executive summary', rows: [], opts: { reportType: 'executive_summary', summary: exec } },
  { name: 'security posture', rows: Array.from({ length: 8 }, (_, i) => postureRow(`WS-0${i + 1}`)), opts: { reportType: 'security_compliance_posture', summary: posture } },
  { name: 'threat detection', rows: [], opts: { reportType: 'threat_detection_review', summary: threat } },
  { name: 'vulnerability management', rows: [], opts: { reportType: 'vulnerability_management', summary: vuln } },
];

const usPartner: ReportBranding = {
  name: 'Example MSP', logoDataUrl: null, logoAspect: null,
  pageSize: 'letter', dateFormat: 'MM/DD/YYYY', timeFormat: '12h',
};
const GENERATED = new Date('2026-11-09T17:06:00.000Z');
const build = (r: (typeof REPORTS)[number], branding: ReportBranding = usPartner): Doc =>
  buildReportPdf(r.rows, { ...r.opts, generatedAt: GENERATED, timezone: 'America/New_York', branding });

describe.each(REPORTS)('$name PDF (#12048)', (report) => {
  it('prints on the partner page size, every page', () => {
    expect(pageSizesMm(build(report)).length).toBeGreaterThan(0);
    for (const [w, h] of pageSizesMm(build(report))) {
      expect(w).toBeCloseTo(279.4, 0);
      expect(h).toBeCloseTo(215.9, 0);
    }
    for (const [w, h] of pageSizesMm(build(report, { ...usPartner, pageSize: 'a4' }))) {
      expect(w).toBeCloseTo(297, 0);
      expect(h).toBeCloseTo(210, 0);
    }
  });

  it('prints the generated time with its timezone, in the partner date format', () => {
    expect(text(build(report))).toContain('Generated Nov 9, 2026, 12:06 PM EST');
    const eu = text(build(report, { ...usPartner, dateFormat: 'DD/MM/YYYY', timeFormat: '24h' }));
    expect(eu).toContain('Generated 9 Nov 2026, 12:06 EST');
  });

  it('prints no ISO dates when the partner uses a spelled-out format, and no pipe separators', () => {
    const t = text(build(report));
    expect(t).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(t).not.toContain(' | ');
    expect(t).not.toMatch(/\)\s*\|\s*\(/); // a pipe between two text runs
  });

  it('draws the partner logo once per page', () => {
    const doc = build(report, { ...usPartner, logoDataUrl: transparentPng(), logoAspect: 4 });
    for (const page of pages(doc)) {
      expect(page.match(/\/I\d+ Do/g) ?? []).toHaveLength(1);
    }
  });
});

describe('build isolation and fallbacks (#12048, #12041)', () => {
  // Every build re-assigns the page geometry and locale first, so a later
  // build cannot inherit them; what can is a formatter exported for use
  // outside a build (executiveSummaryPeriodLabel reads the active locale).
  it('restores the default date format after a build that throws', () => {
    const exploding = new Proxy({ ...vuln }, {
      get(target, key) {
        if (key === 'orgName') throw new Error('render exploded');
        return Reflect.get(target, key);
      },
    });
    expect(() => buildReportPdf([], {
      reportType: 'vulnerability_management', summary: exploding as never, generatedAt: GENERATED,
      timezone: 'Europe/Berlin', branding: { ...usPartner, dateFormat: 'DD/MM/YYYY', timeFormat: '24h' },
    })).toThrow('render exploded');
    expect(executiveSummaryPeriodLabel({ start: '2026-10-10', end: '2026-11-09' }, 'UTC')).toBe('Oct 10, 2026 – Nov 9, 2026');
  });

  it('falls back to the name on the brand band, without throwing, when the logo will not embed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const doc = build(REPORTS[2]!, { ...usPartner, logoDataUrl: 'data:image/png;base64,AAAA', logoAspect: 4 });
      const p1 = pages(doc)[0]!;
      expect(p1).not.toMatch(/\/I\d+ Do/);
      expect(p1).toContain('(Example MSP) Tj');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('draws header and footer exactly once on every page of a long table', () => {
    const rows = Array.from({ length: 90 }, (_, i) => ({ hostname: `WS-${i}`, lastSeen: '2026-11-08T10:00:00Z', status: 'online' }));
    const doc = buildReportPdf(rows, {
      reportType: 'device_inventory', generatedAt: GENERATED, timezone: 'UTC',
      branding: { ...usPartner, logoDataUrl: transparentPng(), logoAspect: 4 },
    });
    const all = pages(doc);
    expect(all.length).toBeGreaterThan(2);
    all.forEach((page) => {
      expect(page.match(/\/I\d+ Do/g) ?? []).toHaveLength(1);
      expect(page.match(/\(Confidential\) Tj/g) ?? []).toHaveLength(1);
    });
  });

  it('formats an instant, keeps a caller-formatted string as given', () => {
    const meta = (generatedAt: string | Date) => text(buildReportPdf([{ a: 1 }], { reportType: 'device_inventory', generatedAt, timezone: 'UTC' }));
    expect(meta(new Date('2026-11-09T17:06:00Z'))).toContain('Generated Nov 9, 2026, 5:06 PM UTC');
    expect(meta('2026-11-09T17:06:00.000Z')).toContain('Generated Nov 9, 2026, 5:06 PM UTC');
    expect(meta('Nov 9, 2026')).toContain('Generated Nov 9, 2026');
  });

  it('formats a Postgres-text timestamp cell in the generic table instead of printing it raw', () => {
    const t = text(buildReportPdf([{ hostname: 'WS-01', lastSeen: '2026-11-09 12:30:00+00' }], {
      reportType: 'device_inventory', generatedAt: GENERATED, timezone: 'UTC',
    }));
    expect(t).toContain('Nov 9, 2026, 12:30 PM UTC');
    expect(t).not.toContain('2026-11-09 12:30:00+00');
  });

  it('the chip check detects a rounded rectangle (positive control for the #12041 assertion)', () => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.roundedRect(10, 10, 20, 10, 1.6, 1.6, 'F');
    expect(pages(doc)[0]).toMatch(/ c\n/);
  });
});

describe('scorecard layout on both page sizes (#12048)', () => {
  it.each([['a4', 297], ['letter', 279.4]] as const)('%s: the meter and its caption stop before the right rail', (_size, pageW) => {
    const contentW = pageW - 28;
    const l = scorecardLayout(14, contentW, true);
    // The rail's divider sits 7 mm left of the rail; keep 4 mm clear of it.
    expect(l.meterX + l.meterW).toBeLessThanOrEqual(l.railX - 7 - 4);
    expect(l.captionW).toBeLessThanOrEqual(l.railX - 7 - 4 - l.meterX);
    expect(l.meterW).toBeGreaterThan(50);
  });

  it('keeps the A4 meter at its designed 88 mm', () => {
    expect(scorecardLayout(14, 269, true).meterW).toBe(88);
  });
});

describe('reporting period line (#12048)', () => {
  it('prints the executive, threat detection and vulnerability periods in the same words and format', () => {
    for (const report of [REPORTS[0]!, REPORTS[2]!, REPORTS[3]!]) {
      expect(text(build(report))).toContain('Reporting period Oct 10, 2026 – Nov 9, 2026');
      expect(text(build(report, { ...usPartner, dateFormat: 'DD/MM/YYYY' }))).toContain('Reporting period 10 Oct 2026 – 9 Nov 2026');
    }
  });
});

describe('header band with a partner logo (#12041)', () => {
  /** Ops from the start of page 1 up to the logo draw: the header band, for
   *  the renderers that draw chrome before content (threat detection and
   *  vulnerability management; the executive and posture covers draw their
   *  content first, so their page-1 ops before the logo include the cover's
   *  own rounded panels). */
  const headerOps = (doc: Doc): string => {
    const p1 = pages(doc)[0] ?? '';
    const at = p1.search(/\/I\d+ Do/);
    expect(at).toBeGreaterThan(-1);
    return p1.slice(0, at);
  };

  it.each(REPORTS.slice(2))('$name: no rounded white chip behind the logo', (report) => {
    const ops = headerOps(build(report, { ...usPartner, logoDataUrl: transparentPng(), logoAspect: 4 }));
    // A rounded rectangle is drawn with Bézier curve ops; the header band is
    // straight rectangles only once the chip is gone.
    expect(ops).not.toMatch(/ c\n/);
  });

  it('keeps the brand-colour band, name and no chip when there is no logo', () => {
    const doc = build(REPORTS[2]!);
    expect(text(doc)).toContain('Example MSP');
  });
});
