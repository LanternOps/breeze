import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The STAFF / BROWSER render path for the Threat Detection Review (#5784 W02).
 *
 * `exportReport` hands `summary` to `buildReportPdf` opaquely, so the failure
 * this test exists to catch is silent: if the summary is dropped or reshaped on
 * the way through, `buildReportPdf`'s arm guard fails and the document falls
 * back to `renderGenericReport` — a plausible-looking PDF with the whole
 * designed body missing. The server-side (`renderRunPdf`) path is proven in
 * apps/api's threatDetectionEvidence integration suite; this covers the second
 * of the three paths, from the same stored-result shape.
 */

// Capture every doc.text() call so we can assert the designed sections landed.
const textCalls: string[] = [];

vi.mock('jspdf', () => {
  // The mock surface must cover every jsPDF method the renderer calls; a
  // missing one would throw before any text() lands and fail vacuously.
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
  const ctor = function () {
    return doc;
  } as unknown as () => typeof doc;
  return { jsPDF: ctor, default: ctor };
});

const autoTable = vi.fn();
vi.mock('jspdf-autotable', () => ({ default: (...args: unknown[]) => autoTable(...args) }));

import { exportReport } from './reportExport';
import type { ReportBranding } from '@breeze/shared/reportPdf';
import type { ThreatDetectionSummary } from '@breeze/shared';

// Pass branding explicitly so the PDF path never hits the network branding fetch.
const noBranding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

const COVERAGE_NOTE =
  'Huntress is not connected for this partner, so threat detection was not measured for this period.';

const summary: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: 'Acme Co',
  generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    coveredFrom: null,
    coveredTo: null,
    generatedAt: '2026-09-30T05:18:00.000Z',
    sourceStatus: 'not_connected',
    lastSyncAt: null,
    lastSyncStatus: null,
    unattributableExcluded: 0,
    withheld: 0,
    note: COVERAGE_NOTE,
  },
  agentCoverage: {
    huntressAgents: null, breezeDevices: 12, agentsOffline: null, devicesWithoutAgent: null,
  },
  incidents: {
    opened: null, resolved: null, bySeverity: null, byStatus: null,
    meanResolveHours: null, medianResolveHours: null, carriedIn: null,
  },
  rows: [],
  dataGaps: [COVERAGE_NOTE],
};

beforeEach(() => {
  textCalls.length = 0;
  autoTable.mockClear();
  // downloadBlob touches the DOM; jsdom supplies it, but the object URL does not.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true });
  }
});

describe('exportReport: threat_detection_review (staff/browser path)', () => {
  it('reaches the designed renderer rather than the generic table', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'threat_detection_review',
      timezone: 'UTC',
      summary: summary as never,
      branding: noBranding,
    });

    const text = textCalls.join('\n');
    // Sections only the threat detection renderer draws.
    expect(text).toContain('Threat Detection Review');
    expect(text).toContain('What this covers');
    expect(text).toContain('Endpoint coverage');
    expect(text).toContain('Acme Co');
  });

  it('prints the coverage note verbatim and renders unmeasured counts as N/A, never 0', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'threat_detection_review',
      timezone: 'UTC',
      summary: summary as never,
      branding: noBranding,
    });

    const text = textCalls.join('\n');
    expect(text).toContain(COVERAGE_NOTE);
    expect(text).toContain('N/A');
    expect(text).not.toMatch(/\b0 incidents\b/i);
    // Breeze's own, measured fleet count still appears as a real number.
    expect(text).toContain('12');
  });

  it('falls back to the generic renderer when the stored result carries no summary', async () => {
    await exportReport([{ a: 1 }], {
      format: 'pdf',
      reportType: 'threat_detection_review',
      timezone: 'UTC',
      branding: noBranding,
    });

    const text = textCalls.join('\n');
    expect(text).not.toContain('What this covers');
  });
});
