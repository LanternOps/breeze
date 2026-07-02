import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
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

describe('buildReportPdf in Node (no DOM)', () => {
  it('renders the posture cover + device table', () => {
    const doc = buildReportPdf(postureRows, { ...opts, reportType: 'security_compliance_posture', summary: postureSummary });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(1000);
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
});
