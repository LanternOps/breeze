import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every doc.text() call so we can assert the scorecard content.
const textCalls: string[] = [];

vi.mock('jspdf', () => {
  const doc = {
    setFontSize: () => doc,
    setTextColor: () => doc,
    setFont: () => doc,
    text: (t: unknown) => {
      textCalls.push(String(t));
      return doc;
    },
    addPage: () => doc,
    splitTextToSize: (t: string) => [t],
    output: () => new Blob(['pdf'], { type: 'application/pdf' }),
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

import { exportReport } from './reportExport';

const summary = {
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

  it('renders the posture scorecard without throwing and prints control percentages', () => {
    expect(() =>
      exportReport([{ hostname: 'pc-1', protection: 'Huntress (RTP on)' }], {
        format: 'pdf',
        reportType: 'security_compliance_posture',
        timezone: 'UTC',
        summary,
      })
    ).not.toThrow();

    const joined = textCalls.join('\n');
    expect(joined).toContain('Security & Compliance Posture');
    expect(joined).toContain('Acme Co');
    expect(joined).toContain('Managed EDR coverage: 67%');
    expect(joined).toContain('Not yet assessed'); // CIS null → not 0%
    expect(joined).toContain('Active PAM rules: 2');
    expect(joined).toMatch(/Huntress/);
    // Honest labels & no-data handling from the review fixes:
    expect(joined).toContain('Identity provider connected (M365/Google): Yes'); // C2: not "MFA"
    expect(joined).not.toContain('MFA / identity connected');
    expect(joined).toContain('Patch current (no critical pending): N/A — not assessed'); // M1: null → N/A
    expect(joined).toContain('(3 unknown)'); // patch unknown surfaced
    expect(joined).toContain('AV definitions current: 100%'); // H2: config-driven control live
    expect(joined).toContain('Local-admin exposure (over threshold): N/A — not assessed (2 unknown)');
  });

  it('shows CIS coverage and degraded DNS sync when present', () => {
    const s = {
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
    exportReport([{ hostname: 'pc-1' }], {
      format: 'pdf',
      reportType: 'security_compliance_posture',
      timezone: 'UTC',
      summary: s,
    });
    const joined = textCalls.join('\n');
    expect(joined).toContain('Hardening (CIS): 95% across 2/3 devices assessed'); // H4 coverage
    expect(joined).toContain('DNS filtering active: No (sync: error)'); // H3 degraded
    expect(joined).toContain('DEGRADED'); // product flagged
  });

  it('omits the CIS hardening line when the section is toggled off', () => {
    const off = { ...summary, controls: { ...summary.controls, cisIncluded: false } };
    exportReport([{ hostname: 'pc-1' }], {
      format: 'pdf',
      reportType: 'security_compliance_posture',
      timezone: 'UTC',
      summary: off,
    });
    expect(textCalls.join('\n')).not.toContain('Hardening (CIS)');
  });

  it('falls back to the plain table when no summary is supplied', () => {
    expect(() =>
      exportReport([{ hostname: 'pc-1' }], {
        format: 'pdf',
        reportType: 'security_compliance_posture',
        timezone: 'UTC',
      })
    ).not.toThrow();
    expect(textCalls.join('\n')).toContain('Security Compliance Posture Report');
  });
});
