import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every doc.text() call so we can assert the scorecard content.
const textCalls: string[] = [];

vi.mock('jspdf', () => {
  // Mock surface must cover every jsPDF method the branded renderer calls;
  // a missing method would throw before any text() lands and fail vacuously.
  const doc = {
    setFontSize: () => doc,
    setTextColor: () => doc,
    setFont: () => doc,
    setFillColor: () => doc,
    setDrawColor: () => doc,
    setLineCap: () => doc,
    setLineJoin: () => doc,
    setLineWidth: () => doc,
    rect: () => doc,
    roundedRect: () => doc,
    circle: () => doc,
    line: () => doc,
    lines: () => doc,
    addImage: () => doc,
    getTextWidth: () => 10,
    text: (t: unknown) => {
      textCalls.push(String(t));
      return doc;
    },
    addPage: () => doc,
    splitTextToSize: (t: string) => [t],
    output: () => new Blob(['pdf'], { type: 'application/pdf' }),
    getCurrentPageInfo: () => ({ pageNumber: 1 }),
    getNumberOfPages: () => 1,
    putTotalPages: () => doc,
    internal: { pageSize: { getWidth: () => 842, getHeight: () => 595 } },
    lastAutoTable: { finalY: 100 },
  };
  // Must be constructable (`new jsPDF()`), so a regular function — not an arrow.
  const ctor = function () {
    return doc;
  } as unknown as () => typeof doc;
  return { jsPDF: ctor, default: ctor };
});

vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

import { exportReport, type PostureSummary } from './reportExport';
import type { ReportBranding } from './reportPdf';

// Pass branding explicitly so the PDF path never hits the network branding fetch.
const noBranding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

const summary: PostureSummary = {
  org: { id: 'o1', name: 'Acme Co' },
  generatedAt: '2026-06-29T00:00:00Z',
  deviceCount: 3,
  controls: {
    edrCoveragePct: 67,
    anyAvCoveragePct: 67,
    unprotectedCount: 1,
    avDefinitionsCurrentPct: 100,
    encryptionPct: 100,
    firewallPct: 100,
    patchCurrentPct: null, // not assessed → renders N/A
    patchUnknownCount: 3,
    passwordComplexityPct: 50,
    passwordUnknownCount: 1,
    localAdminExposurePct: null,
    localAdminUnknownCount: 2,
    cisAvgPassRate: null,
    cisAssessedCount: 0,
    identityProviderConnected: true,
    backupConfigured: true,
    backupEncrypted: true,
    dnsFilteringActive: true,
    dnsFilteringSyncStatus: 'success',
  },
  privilegedAccess: {
    uacInterceptionEnabled: true,
    activePamRules: 2,
    elevationsInWindow: 4,
    elevationsApproved: 3,
    elevationsDenied: 1,
    mfaStepUpEnforced: true,
  },
  securityProducts: [
    { product: 'Huntress', category: 'mdr', active: true, lastSyncStatus: null, deviceCoverage: 2 },
  ],
  postureScore: 82,
};

describe('exportReport — security_compliance_posture PDF', () => {
  beforeEach(() => {
    textCalls.length = 0;
    // jsdom has no object-URL impl; stub for downloadBlob.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  });

  it('renders the branded scorecard and surfaces control values + honest N/A', async () => {
    await exportReport([{ hostname: 'pc-1', protection: 'Huntress (RTP on)' }], {
      format: 'pdf',
      reportType: 'security_compliance_posture',
      timezone: 'UTC',
      summary,
      branding: noBranding,
    });

    const joined = textCalls.join('\n');
    expect(joined).toContain('Security & Compliance Posture'); // title
    expect(joined).toContain('Acme Co'); // org subtitle
    expect(joined).toContain('STRONG'); // score band chip (82)
    // Control coverage renders label + value as distinct cells.
    expect(joined).toContain('Managed EDR coverage');
    expect(joined).toContain('67%');
    expect(joined).toContain('AV definitions current'); // config-driven control live
    expect(joined).toContain('100%');
    expect(joined).toContain('CIS hardening');
    expect(joined).toContain('Not assessed'); // CIS null → not a misleading 0%
    expect(joined).toContain('Active PAM rules');
    expect(joined).toMatch(/Huntress/);
    // Honest labels & no-data handling preserved from the review fixes:
    expect(joined).toContain('Identity provider connected'); // not "MFA"
    expect(joined).not.toContain('MFA / identity connected');
    expect(joined).toContain('Patch current (no critical pending)');
    expect(joined).toContain('N/A'); // null pct → N/A, never 0%
    expect(joined).toContain('Local-admin exposure');
  });

  it('shows CIS coverage and flags degraded products when present', async () => {
    const s: PostureSummary = {
      ...summary,
      controls: {
        ...summary.controls,
        cisIncluded: true,
        cisAvgPassRate: 95,
        cisAssessedCount: 2,
        dnsFilteringActive: false,
        dnsFilteringSyncStatus: 'error',
      },
      securityProducts: [
        { product: 'Cisco Umbrella', category: 'dns_filtering', active: false, lastSyncStatus: 'error', deviceCoverage: null },
      ],
    };
    await exportReport([{ hostname: 'pc-1' }], {
      format: 'pdf',
      reportType: 'security_compliance_posture',
      timezone: 'UTC',
      summary: s,
      branding: noBranding,
    });
    const joined = textCalls.join('\n');
    expect(joined).toContain('CIS hardening');
    expect(joined).toContain('95% (2/3)'); // pass-rate with assessed/total-scope coverage
    expect(joined).toContain('DNS filtering active'); // grid shows clean Yes/No
    expect(joined).toContain('not reporting'); // degraded product flagged, plain language
    expect(joined).toContain('sync error'); // sync problem surfaced on the product
  });

  it('omits the CIS hardening line when the section is toggled off', async () => {
    const off = { ...summary, controls: { ...summary.controls, cisIncluded: false } };
    await exportReport([{ hostname: 'pc-1' }], {
      format: 'pdf',
      reportType: 'security_compliance_posture',
      timezone: 'UTC',
      summary: off,
      branding: noBranding,
    });
    expect(textCalls.join('\n')).not.toContain('CIS hardening');
  });

  it('falls back to the branded generic table when no summary is supplied', async () => {
    await expect(
      exportReport([{ hostname: 'pc-1' }], {
        format: 'pdf',
        reportType: 'security_compliance_posture',
        timezone: 'UTC',
        branding: noBranding,
      })
    ).resolves.toBeUndefined();
    expect(textCalls.join('\n')).toContain('Security & Compliance Posture'); // display label keeps the ampersand
  });
});
