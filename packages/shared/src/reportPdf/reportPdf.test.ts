import { describe, expect, it } from 'vitest';
import { buildPostureBackupMetric, buildReportPdf } from './reportPdf';
import type { PostureSummary } from '../types/postureReport';
import type { ExecutiveSummary } from '../types/executiveSummaryReport';
import type { FleetDesignReportSummary, FleetDesignSubmission } from '../types/fleetDesign';
import { fleetDesignOutcomeFromSubmission, type FleetDesignOutcomeRefs } from '../validators/fleetDesign';

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

  it('spells out the RTP-on subset so one active device is not read as full coverage (issue #2517)', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      securityProducts: [
        // Installed on 200, real-time protection on for only 1.
        { product: 'Defender', category: 'antivirus', active: true, deviceCoverage: 200, activeDeviceCoverage: 1 },
      ],
    };
    const doc = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary,
    });
    const text = pdfCommandText(doc);
    expect(text).toContain('200 devices, 1 with real-time protection on');
  });

  it('omits the RTP subset note when every installed device is active', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      securityProducts: [
        { product: 'SentinelOne', category: 'edr', active: true, deviceCoverage: 4, activeDeviceCoverage: 4 },
      ],
    };
    const doc = buildReportPdf(postureRows, {
      ...opts,
      reportType: 'security_compliance_posture',
      summary,
    });
    const text = pdfCommandText(doc);
    expect(text).toContain('4 devices');
    expect(text).not.toContain('with real-time protection on');
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

// Copied from validators/fleetDesign.test.ts's validSubmission() so this file
// doesn't depend on another test module's fixtures. Intentionally loosely
// typed (inferred, not annotated FleetDesignSubmission) — see that file for why.
const FD1 = '11111111-1111-4111-8111-111111111111';
const FD2 = '22222222-2222-4222-8222-222222222222';

function validFleetDesignSubmission() {
  return {
    found: {
      summary: ['12 devices across 2 sites.'],
      findings: [{ title: 'Shared local admin on 4 workstations', deviceCount: 4, evidence: ['posture:localAdmin'] }],
    },
    functions: [
      { functionKey: 'file_server', deviceIds: [FD1], confidence: 0.9, evidence: ['SMB listener; 2 TB data volume'] },
    ],
    monitoring: [
      {
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'SMB is the function.' }],
        alertRules: [{
          name: 'File server disk over 85%', severity: 'high',
          conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 85, durationMinutes: 15 }],
          cooldownMinutes: 60, rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
        }],
      },
    ],
    retired: [{ kind: 'watch', policyId: 'p1', policyName: 'Legacy monitoring', itemName: 'Print Spooler', reason: 'No print server function detected.' }],
    automation: [{ functionKey: 'file_server', playbooks: [{ builtInName: 'Restart stopped service' }], scripts: [] }],
    legacy: [{ scriptId: 's1', scriptName: 'cleanup.ps1', intent: 'Disk cleanup', bucket: 'covered', coveredBy: 'Automation: file_server', notes: 'Superseded by the new automation.' }],
    baseline: { notes: ['Alert rate is dominated by disk warnings.'] },
    unsure: {
      lowConfidenceFunctions: [{ functionKey: 'kiosk', deviceIds: [FD2], confidence: 0.4, evidence: ['single logon user'] }],
      unreachableDevices: [], needsHuman: [], roleCorrections: [],
    },
  };
}

const fleetDesignRefs: FleetDesignOutcomeRefs = {
  deviceIds: new Set([FD1, FD2]),
  baseline: { alertsPer100EndpointsPerMonth: 42, ticketsPerMonth: 7, precursors: [{ condition: 'disk_used_over_threshold', deviceCount: 3 }] },
  generatedAt: '2026-09-12T00:00:00.000Z',
};

const outcomeFixture = fleetDesignOutcomeFromSubmission(
  validFleetDesignSubmission() as unknown as FleetDesignSubmission,
  fleetDesignRefs,
);

describe('buildReportPdf: ai_fleet_design', () => {
  it('renders a fleet design summary without throwing and titles it Fleet Design', () => {
    const summary: FleetDesignReportSummary = {
      fleetDesign: {
        schemaVersion: 1,
        outcome: outcomeFixture,
        orgName: 'Acme',
        agentName: 'Designer',
        generatedAt: '2026-09-12T09:00:00Z',
      },
    };
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    const text = pdfCommandText(doc);
    expect(text).toContain('Fleet Design');
    // Discriminate against the generic fallback's titleCase("ai_fleet_design")
    // -> "Ai Fleet Design" (which also contains the substring "Fleet Design").
    expect(text).not.toContain('Ai Fleet Design');
    expect(text).toContain('What was found');
  });

  it('names the evidence sections that were not measured so a zero is never read as a measurement', () => {
    const summary: FleetDesignReportSummary = {
      fleetDesign: { outcome: outcomeFixture, orgName: 'Acme', unavailable: ['counts', 'precursors'] },
    };
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary });
    expect(pdfCommandText(doc)).toContain('Not measured: counts, precursors');
    const clean = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary: { fleetDesign: { outcome: outcomeFixture, orgName: 'Acme' } } });
    expect(pdfCommandText(clean)).not.toContain('Not measured');
  });

  it('renders every section title and key section content', () => {
    const summary: FleetDesignReportSummary = { fleetDesign: { outcome: outcomeFixture, orgName: 'Acme' } };
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary });
    const text = pdfCommandText(doc);
    expect(text).toContain('What was found');
    expect(text).toContain('What each device is for');
    expect(text).toContain('What to watch, and why');
    expect(text).toContain('What is not carried forward');
    expect(text).toContain('Automation');
    expect(text).toContain('Legacy script inventory');
    expect(text).toContain('Baseline and precursors');
    expect(text).toContain('What the designer is unsure about');
    expect(text).toContain('LanmanServer');
    expect(text).toContain('File server disk over 85%');
    expect(text).toContain('Print Spooler');
    expect(text).toContain('cleanup.ps1');
  });

  it('renders a "Drift since the approved design" section before the eight sections when drift is present (W05)', () => {
    const summary: FleetDesignReportSummary = {
      fleetDesign: {
        outcome: outcomeFixture,
        orgName: 'Acme',
        drift: {
          approvedReportRunId: 'run-1',
          appliedAt: '2026-06-01T10:00:00.000Z',
          missing: [{ functionKey: 'file_server', kind: 'rule', name: 'SMB share offline' }],
          extra: [{ policyId: 'p2', policyName: 'Hand-made', kind: 'watch', name: 'Fax', deviceCount: 3 }],
          changed: [{ functionKey: 'file_server', kind: 'watch', name: 'Spooler', field: 'enabled', approved: 'true', live: 'false' }],
        },
      },
    };
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary });
    const text = pdfCommandText(doc);
    expect(text).toContain('Drift since the approved design');
    expect(text).toContain('2026-06-01');
    expect(text).toContain('SMB share offline');
    expect(text).toContain('Hand-made');
    expect(text).toContain('Spooler');
    expect(text.indexOf('Drift since the approved design')).toBeLessThan(text.indexOf('What was found'));
  });

  it('omits the drift section when drift is null or absent', () => {
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary: { fleetDesign: { outcome: outcomeFixture, orgName: 'Acme', drift: null } } });
    expect(pdfCommandText(doc)).not.toContain('Drift since the approved design');
  });

  it('includes the proposals-only footnote', () => {
    const summary: FleetDesignReportSummary = { fleetDesign: { outcome: outcomeFixture, orgName: 'Acme' } };
    const doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary });
    const text = pdfCommandText(doc);
    expect(text).toContain('Proposals only');
    expect(text).toContain('nothing here is live until a technician applies it.');
  });

  it('renders without throwing when the outcome (and every other optional field) is absent', () => {
    const summary: FleetDesignReportSummary = { fleetDesign: {} };
    let doc: ReturnType<typeof buildReportPdf> | undefined;
    expect(() => {
      doc = buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary });
    }).not.toThrow();
    expect(doc!.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('falls through to the generic branch without throwing when fleetDesign is missing', () => {
    expect(() => buildReportPdf([], { reportType: 'ai_fleet_design', generatedAt: '2026-09-12 09:00', timezone: 'UTC', summary: {} as FleetDesignReportSummary })).not.toThrow();
  });
});
