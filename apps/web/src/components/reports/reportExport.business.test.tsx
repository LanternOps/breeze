import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3198 W03 — the STAFF / BROWSER render path for the three business report
 * types (ticket SLA attainment, technician time & billability, AR aging).
 *
 * `BuildOpts.summary` in `packages/shared/src/reportPdf/reportPdf.ts` already
 * accepts these three summary types and has a designed arm for each
 * (verified by `reportPdf.ticketSla.test.ts` / `.technicianTime.test.ts` /
 * `.arAging.test.ts` in the shared package). The `summary` union on
 * `exportReport` (this file) and the `handleDownload` cast in
 * `ReportsList.tsx` are narrower TypeScript annotations layered on top of
 * that same runtime call — widening them is a type-only change with no
 * runtime branch of its own, so there is no vitest-observable red for it:
 * `vitest run` transpiles without type-checking, so a call passing an
 * `ArAgingSummary` through the (pre-widening) narrower-typed `summary`
 * parameter already reaches `buildReportPdf` unchanged at runtime — only
 * `tsc`/`astro check` would have rejected the call. This test pins that
 * runtime pass-through (the load-bearing behavior) so a future refactor that
 * drops or re-narrows the union is caught here even though the type widening
 * itself cannot go red in this suite.
 */

// Capture every doc.text() call so we can assert each report's designed
// title rendered, proving buildReportPdf's business arm fired rather than
// falling through to renderGenericReport.
const textCalls: string[] = [];

vi.mock('jspdf', () => {
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

vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

import { exportReport } from './reportExport';
import type { ReportBranding } from '@breeze/shared/reportPdf';
import {
  emptyTicketSlaSummary,
  emptyTechnicianTimeSummary,
  emptyArAgingSummary,
} from '@breeze/shared';

const noBranding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

describe('exportReport — business report summaries reach the PDF (staff/browser path)', () => {
  beforeEach(() => {
    textCalls.length = 0;
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  });

  it('reaches the ticket SLA attainment arm, not renderGenericReport', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'ticket_sla_attainment',
      timezone: 'UTC',
      summary: emptyTicketSlaSummary('No tickets in this period.'),
      branding: noBranding,
    });
    expect(textCalls).toContain('Ticket SLA attainment');
  });

  it('reaches the technician time & billability arm, not renderGenericReport', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'technician_time_billability',
      timezone: 'UTC',
      summary: emptyTechnicianTimeSummary('No logged time in this period.'),
      branding: noBranding,
    });
    expect(textCalls).toContain('Technician time & billability');
  });

  it('reaches the AR aging arm, not renderGenericReport', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'ar_aging',
      timezone: 'UTC',
      summary: emptyArAgingSummary('No open invoices as of this date.'),
      branding: noBranding,
    });
    expect(textCalls).toContain('AR aging');
  });
});
