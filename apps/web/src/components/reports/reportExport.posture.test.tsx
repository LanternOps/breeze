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
    encryptionPct: 100,
    firewallPct: 100,
    patchCurrentPct: 67,
    passwordComplexityPct: 50,
    localAdminExposurePct: 0,
    cisAvgPassRate: null,
    mfaIdentityConnected: true,
    backupConfigured: true,
    backupEncrypted: true,
    dnsFilteringActive: true,
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
