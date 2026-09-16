import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every doc.text() call so we can assert which renderer ran.
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

import { exportReport } from './reportExport';
import type { EndpointManagementSummary } from '@breeze/shared';
import type { ReportBranding } from '@breeze/shared/reportPdf';

// Pass branding explicitly so the PDF path never hits the network branding fetch.
const noBranding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

const summary: EndpointManagementSummary = {
  orgId: 'o1',
  orgName: 'Acme Co',
  generatedAt: '2026-09-30T06:00:00.000Z',
  period: { start: '2026-09-01', end: '2026-09-30' },
  freshness: {
    intune_devices: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', stale: false, note: '' },
  },
  enrolment: { intuneDevices: 42, breezeDevices: 45, breezeWithoutIntune: 4, intuneWithoutBreezeLink: 1 },
  compliance: { byState: { compliant: 38, noncompliant: 2, inGracePeriod: 1, unknown: 1 } },
  staleEnrolments: { count: 3, thresholdDays: 14 },
  licences: [{ skuPartNumber: 'SPE_E3', consumedUnits: 40, prepaidEnabled: 45, prepaidWarning: 0, prepaidSuspended: 0, capabilityStatus: 'Enabled' }],
  rows: [],
  dataGaps: [],
  historyCaveat: 'Device-level change history is not available.',
};

/**
 * The THIRD render path (#5784 W03): the staff / browser export. The portal's
 * server-side `renderRunPdf` is covered by the integration suite and the shared
 * `buildReportPdf` arm by `reportPdf.endpointManagement.test.ts`; this proves
 * the browser path hands the DESIGNED summary through rather than dropping it
 * and degrading to `renderGenericReport`.
 */
describe('exportReport — endpoint_management_review PDF', () => {
  beforeEach(() => {
    textCalls.length = 0;
    // jsdom has no object-URL impl; stub for downloadBlob.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  });

  it('renders the endpoint management cover, not the generic row table', async () => {
    await exportReport([{ deviceName: 'LT-001' }], {
      format: 'pdf',
      reportType: 'endpoint_management_review',
      timezone: 'UTC',
      summary,
      branding: noBranding,
    });

    const joined = textCalls.join('\n');
    expect(joined).toContain('Endpoint Management Review');
    expect(joined).toContain('Acme Co');
    // Section headings only the dedicated renderer emits.
    expect(joined).toContain('Enrolment coverage');
    expect(joined).toContain('Compliance');
    expect(joined).toContain('Stale enrolments');
    expect(joined).toContain('About this report');
    expect(joined).toContain('42');
  });

  it('prints N/A rather than 0 for an unmeasured population', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'endpoint_management_review',
      timezone: 'UTC',
      summary: {
        ...summary,
        enrolment: { intuneDevices: null, breezeDevices: null, breezeWithoutIntune: null, intuneWithoutBreezeLink: null },
        compliance: { byState: null },
        staleEnrolments: { count: null, thresholdDays: 14 },
        dataGaps: ['intune_devices: consent has not been granted.'],
      },
      branding: noBranding,
    });

    const joined = textCalls.join('\n');
    expect(joined).toContain('N/A');
    expect(joined).toContain('consent has not been granted');
    // The unmeasured compliance and stale-enrolment sections must say so in
    // words, not fall back to a zero the reader would take as a measurement.
    expect(joined).toContain('not measured for this period');
  });
});
