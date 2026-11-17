import { describe, expect, it } from 'vitest';
import { buildPostureBackupMetric, buildPostureCoverageMetrics, buildReportPdf, postureScoreBand } from './reportPdf';
import type { PostureSummary } from '../types/postureReport';

// Security & Compliance Posture PDF: figures and colours that must agree with
// each other (#12044) and a layout that never strands content (#12043).

const CP1252_HIGH =
  '€\u0081‚ƒ„…†‡' +
  'ˆ‰Š‹Œ\u008dŽ\u008f' +
  '\u0090‘’“”•–—' +
  '˜™š›œ\u009džŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);
type Doc = ReturnType<typeof buildReportPdf>;
const pages = (doc: Doc): string[] =>
  ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((page): page is string[] => Array.isArray(page))
    .map((page) => decodeWinAnsi(page.join('\n')));
const text = (doc: Doc): string => pages(doc).join('\n');

const opts = { generatedAt: 'Nov 9, 2026, 9:00 AM', timezone: 'UTC', reportType: 'security_compliance_posture' } as const;

// The reported shape: 8 in-scope devices, score 64, 0 critical patches but 154
// critical vulnerabilities, one device that never reported security status.
const summary: PostureSummary = {
  org: { id: 'o1', name: 'Example Client' },
  deviceCount: 8,
  postureScore: 64,
  controls: {
    edrCoveragePct: 63, edrUnknownCount: 0,
    anyAvCoveragePct: 100, anyAvUnknownCount: 1, unprotectedCount: 0,
    avDefinitionsCurrentPct: 100,
    encryptionPct: 100, encryptionUnknownCount: 1,
    firewallPct: 100, firewallUnknownCount: 2,
    patchCurrentPct: 100, patchUnknownCount: 1,
    passwordComplexityPct: 0, passwordUnknownCount: 1,
    localAdminExposurePct: 83, localAdminUnknownCount: 2,
    cisIncluded: false,
    identityProviderConnected: false,
    backupRequired: false,
    backupConfigured: false,
    dnsFilteringActive: false,
  },
  privilegedAccess: { uacInterceptionEnabled: false, activePamRules: 0, windowDays: 30, elevationsInWindow: 0, mfaStepUpEnforced: false },
  securityProducts: [
    { product: 'Huntress', category: 'mdr', active: true, deviceCoverage: 4, activeDeviceCoverage: 4 },
    { product: 'SentinelOne', category: 'edr', active: true, deviceCoverage: 3, activeDeviceCoverage: 3 },
    { product: 'Windows Defender', category: 'antivirus', active: true, deviceCoverage: 4, activeDeviceCoverage: 4 },
    { product: 'Webroot', category: 'antivirus', active: false, deviceCoverage: 1, activeDeviceCoverage: 0 },
  ],
};

const row = (hostname: string, over: Record<string, unknown> = {}) => ({
  hostname, site: 'Main Office', os: 'windows', protection: 'Windows Defender (RTP on)', protectionManaged: false,
  realTimeProtection: true, avDefinitionsAgeDays: 1, encryption: 'encrypted', firewall: true, localAdmins: 3,
  patchAssessed: true, pendingPatches: 2, criticalPatches: 0, openVulnCritical: 19, openVulnHigh: 5, cisPassRate: null,
  posture: null, ...over,
});
const rows = [
  row('WS-01', { openVulnCritical: 35 }),
  row('WS-02'), row('WS-03'), row('WS-04'), row('WS-05'), row('WS-06'), row('WS-07'),
  row('WS-08', { protection: 'No data', realTimeProtection: null, encryption: 'no data', firewall: null, localAdmins: null, openVulnCritical: 5 }),
];
const render = (s: PostureSummary = summary, r: Record<string, unknown>[] = rows): Doc =>
  buildReportPdf(r, { ...opts, summary: s });
const statusOf = (s: PostureSummary, label: string) => buildPostureCoverageMetrics(s).find((m) => m.label === label);

describe('posture score band (#12044)', () => {
  it('keeps the score-derived band when nothing critical is open', () => {
    expect(postureScoreBand(64, { criticalFindings: 0, unprotected: 0 }).label).toBe('GOOD');
    expect(postureScoreBand(85, { criticalFindings: 0, unprotected: 0 }).label).toBe('STRONG');
  });

  it('holds a GOOD or STRONG score at FAIR while critical findings are open or a device is unprotected', () => {
    expect(postureScoreBand(64, { criticalFindings: 154, unprotected: 0 }).label).toBe('FAIR');
    expect(postureScoreBand(92, { criticalFindings: 1, unprotected: 0 }).label).toBe('FAIR');
    expect(postureScoreBand(92, { criticalFindings: 0, unprotected: 1 }).label).toBe('FAIR');
    // Never raises a lower band.
    expect(postureScoreBand(30, { criticalFindings: 9, unprotected: 0 }).label).toBe('AT RISK');
  });

  it('draws GOOD in a status colour, not the brand primary', () => {
    const good = postureScoreBand(64, { criticalFindings: 0, unprotected: 0 });
    const strong = postureScoreBand(85, { criticalFindings: 0, unprotected: 0 });
    expect(good.color).toEqual(strong.color);
  });

  it('prints FAIR, not GOOD, beside 154 critical vulnerabilities and states what the bands mean', () => {
    const t = text(render());
    expect(t).not.toContain('(GOOD)');
    expect(t).toContain('(FAIR)');
    expect(t).toMatch(/held at Fair while critical/i);
  });
});

describe('posture hero figures (#12044)', () => {
  it('splits critical patches from critical vulnerabilities', () => {
    const t = text(render());
    expect(t).not.toContain('Critical patches/vulns');
    expect(t).toContain('(Critical patches)');
    expect(t).toContain('(Critical vulnerabilities)');
    expect(t).toContain('(154)');
  });

  it('counts AV protection over assessed devices and discloses the not-assessed one', () => {
    const t = text(render());
    // 8 in scope, 1 not assessed, 0 unprotected: 7 of 7 assessed are protected.
    expect(t).toContain('(7/7)');
    expect(t).not.toContain('(8/8)');
    expect(t).toContain('(AV protected)');
    expect(t).toContain('(1 not assessed)');
  });

  it('does not count a no-data row as unprotected when a legacy snapshot lacks unprotectedCount', () => {
    const legacy: PostureSummary = { ...summary, controls: { ...summary.controls, unprotectedCount: undefined, anyAvUnknownCount: undefined } };
    const t = text(render(legacy));
    expect(t).not.toMatch(/Deploy protection/);
  });
});

describe('posture control colours (#12044)', () => {
  it('applies one rule when part of the fleet is not assessed: a pass needs every device assessed', () => {
    expect(statusOf(summary, 'Disk encryption')?.status).toBe('warn');
    expect(statusOf(summary, 'Patch current (no critical pending)')?.status).toBe('warn');
    expect(statusOf(summary, 'Host firewall')?.status).toBe('warn');
  });

  it('never hides a measured shortfall behind the not-assessed grey', () => {
    expect(statusOf(summary, 'Password policy')?.status).toBe('bad');
    // 83% exposure against a 10% target, 2 of 8 not assessed.
    expect(statusOf(summary, 'Local-admin exposure')?.status).toBe('bad');
  });

  it('keeps green when every device was assessed, and grey only when nothing was', () => {
    const full: PostureSummary = { ...summary, controls: { ...summary.controls, encryptionUnknownCount: 0 } };
    expect(statusOf(full, 'Disk encryption')?.status).toBe('good');
    const none: PostureSummary = { ...summary, controls: { ...summary.controls, encryptionPct: null, encryptionUnknownCount: 8 } };
    expect(statusOf(none, 'Disk encryption')?.status).toBe('na');
  });

  it('discloses not-assessed devices on the unprotected row instead of reading them as protected', () => {
    const m = statusOf(summary, 'Unprotected devices');
    expect(m?.value).toBe('0 · 1 not assessed');
    expect(m?.status).toBe('warn');
    const bad: PostureSummary = { ...summary, controls: { ...summary.controls, unprotectedCount: 2 } };
    expect(statusOf(bad, 'Unprotected devices')?.status).toBe('bad');
  });

  it('writes targets without ASCII >= / <=', () => {
    const metrics = buildPostureCoverageMetrics(summary);
    for (const m of metrics) {
      expect(m.target ?? '').not.toMatch(/>=|<=/);
    }
    expect(statusOf(summary, 'Disk encryption')?.target).toBe('90%+');
    expect(statusOf(summary, 'Local-admin exposure')?.target).toBe('max 10%');
  });

  it('labels a backup that is not required "Not in scope" and the hollow legend dot "Not scored"', () => {
    expect(buildPostureBackupMetric({ backupRequired: false, backupConfigured: false }).value).toBe('Not in scope');
    const t = text(render());
    expect(t).toContain('(Not scored)');
    expect(t).not.toContain('(Informational)');
  });
});

describe('posture recommendations (#12044, #12043)', () => {
  it('words a single unprotected device in the singular', () => {
    const one: PostureSummary = { ...summary, controls: { ...summary.controls, unprotectedCount: 1 } };
    const t = text(render(one));
    expect(t).toContain('Deploy protection to the unprotected device');
    expect(t).not.toContain('the 1 unprotected device');
  });

  it('renders every recommendation instead of truncating, with no "available in Breeze" line', () => {
    const t = text(render());
    expect(t).not.toContain('available in Breeze');
    expect(t).not.toMatch(/further recommendation/);
    for (const needle of [
      'Remediate 154 critical vulnerabilities',
      'Enforce MFA step-up',
      'Reduce local administrator rights',
      'Connect an identity provider',
      'Enable DNS filtering',
      'Extend EDR coverage',
      'Enable UAC interception',
      'minimum password length',
      'device that has not reported protection status',
    ]) {
      expect(t).toContain(needle);
    }
  });
});

describe('posture layout (#12043)', () => {
  it('never prints the products heading on a page with no product under it', () => {
    for (const page of pages(render())) {
      if (!page.includes('(Security products in use')) continue;
      expect(page).toMatch(/\((Huntress|SentinelOne|Windows Defender|Webroot)/);
    }
  });

  it('starts the per-device table on the continuation page when it fits (no near-empty page)', () => {
    const doc = render();
    const ps = pages(doc);
    const productsPage = ps.findIndex((p) => p.includes('(Webroot'));
    const detailPage = ps.findIndex((p) => p.includes('Per-device detail'));
    expect(productsPage).toBeGreaterThanOrEqual(0);
    expect(detailPage).toBe(productsPage);
    expect(doc.getNumberOfPages()).toBe(2);
  });
});

describe('posture scope and duplicates (#12044)', () => {
  it('states how many managed devices the site filter left out', () => {
    const t = text(render({ ...summary, excludedBySiteFilterCount: 4 }));
    expect(t).toContain('8 devices in scope');
    expect(t).toContain('4 managed devices at other sites not included');
  });

  it('distinguishes two devices that share a hostname by last check-in', () => {
    const dupRows = [
      row('WS-01', { lastSeenAt: '2026-10-02T10:00:00Z' }),
      row('WS-01', { lastSeenAt: '2026-11-09T08:00:00Z' }),
      row('WS-02', { lastSeenAt: '2026-11-09T08:00:00Z' }),
    ];
    const t = text(render(summary, dupRows));
    expect(t).toContain('last seen Oct 2, 2026');
    expect(t).toContain('last seen Nov 9, 2026');
    // A unique hostname is not annotated.
    expect(t.match(/last seen/g)?.length).toBe(2);
  });
});
