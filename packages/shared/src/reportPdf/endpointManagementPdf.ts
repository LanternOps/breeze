/**
 * Endpoint Management Review PDF (#5784 W03) — the customer-facing artifact for
 * an "Intune management" service-plan deliverable.
 *
 * Pure rendering over the persisted `EndpointManagementSummary` snapshot: every
 * count, bucket and trend point was computed at generation time by
 * `services/endpointManagementReport.ts`, so an old snapshot re-renders
 * identically. The design system (header band, footer, title block, section
 * headings, palette) arrives through `chrome` so this module never imports
 * `reportPdf.ts` back — that would be a cycle.
 *
 * Two rules the whole page obeys:
 *
 *  - **Unmeasured is printed as `N/A` with its reason, never as `0`.** A null
 *    count means the Intune domain has not completed a snapshot, needs consent,
 *    was throttled or is unlicensed. Printing a zero there would be a lie the
 *    reader cannot detect, so the data-gap panel names the gap instead.
 *  - **The history caveat is always printed.** `last_changed_at` churns on every
 *    Intune check-in and stale entities are deleted after 30 days, so
 *    device-level "what changed this month" does not exist. The page says so
 *    rather than letting the reader infer it from a trend chart.
 *
 * The renderer is English-only by design: the eight locale files localize the
 * web UI, not the PDF.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  ComplianceState,
  EndpointManagementSummary,
  IntuneDeviceRow,
  LicenceSeatRow,
} from '../types/endpointManagementReport';
import { COMPLIANCE_STATES } from '../types/endpointManagementReport';

type RGB = [number, number, number];

/** The pieces of reportPdf.ts's design system this renderer needs. Structurally
 *  identical to `hardwareLifecyclePdf.ts`'s — declared, not imported, so the
 *  two renderers stay independent of each other. */
export type PdfChrome = {
  C: {
    ink: RGB; primary: RGB; success: RGB; danger: RGB; warning: RGB;
    muted: RGB; faint: RGB; rule: RGB; zebra: RGB; panel: RGB; white: RGB;
  };
  PAGE: { w: number; h: number; mx: number; bandH: number; footY: number };
  drawHeaderBand: (doc: jsPDF) => void;
  drawFooter: (doc: jsPDF) => void;
  drawTitleBlock: (doc: jsPDF, title: string, subtitle: string, meta: string, top: number) => number;
  drawSectionHeading: (doc: jsPDF, text: string, y: number) => number;
};

export type EndpointManagementPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
const fill = (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);

/** The one place a possibly-unmeasured number becomes text. */
const num = (value: number | null | undefined): string =>
  typeof value === 'number' ? String(value) : 'N/A';

const COMPLIANCE_LABELS: Record<ComplianceState, string> = {
  compliant: 'Compliant',
  noncompliant: 'Not compliant',
  inGracePeriod: 'In grace period',
  unknown: 'Unknown',
};

function complianceColor(C: PdfChrome['C'], state: ComplianceState): RGB {
  if (state === 'compliant') return C.success;
  if (state === 'noncompliant') return C.danger;
  if (state === 'inGracePeriod') return C.warning;
  return C.faint;
}

function wrap(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

/** Wrapped body paragraph; returns the y below it. */
function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = wrap(doc, text, PAGE.w - PAGE.mx * 2);
  const lineH = size * 0.56;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 2.5;
}

/** Start a fresh page (with chrome) when `needed` mm will not fit. */
function ensureSpace(doc: jsPDF, chrome: PdfChrome, y: number, needed: number): number {
  if (y + needed <= chrome.PAGE.footY - 6) return y;
  doc.addPage();
  chrome.drawHeaderBand(doc);
  chrome.drawFooter(doc);
  return chrome.PAGE.bandH + 10;
}

/** A row of big-number tiles. A null value reads `N/A`, never `0`. */
function drawTiles(
  doc: jsPDF,
  chrome: PdfChrome,
  tiles: Array<{ label: string; value: number | null | undefined }>,
  y: number,
): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  const gap = 4;
  const w = (width - gap * (tiles.length - 1)) / Math.max(1, tiles.length);
  const h = 18;
  tiles.forEach((tile, i) => {
    const x = PAGE.mx + i * (w + gap);
    fill(doc, C.panel);
    doc.rect(x, y, w, h, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    ink(doc, typeof tile.value === 'number' ? C.ink : C.muted);
    doc.text(num(tile.value), x + 3, y + 8.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    ink(doc, C.muted);
    wrap(doc, tile.label, w - 6).slice(0, 2).forEach((line, li) => {
      doc.text(line, x + 3, y + 13 + li * 3.6);
    });
  });
  return y + h + 5;
}

function drawDataGaps(doc: jsPDF, chrome: PdfChrome, gaps: string[], y: number): number {
  if (gaps.length === 0) return y;
  const { C, PAGE } = chrome;
  let cursor = ensureSpace(doc, chrome, y, 14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  ink(doc, C.warning);
  doc.text('What we could not measure', PAGE.mx, cursor);
  cursor += 4.5;
  for (const gap of gaps) {
    cursor = ensureSpace(doc, chrome, cursor, 10);
    cursor = drawProse(doc, chrome, `• ${gap}`, cursor, 8.6, C.muted);
  }
  return cursor + 1.5;
}

export function renderEndpointManagementReport(
  doc: jsPDF,
  summary: EndpointManagementSummary,
  opts: EndpointManagementPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const rows: IntuneDeviceRow[] = Array.isArray(summary.rows) ? summary.rows : [];

  // --- cover ---------------------------------------------------------------
  const periodLabel = summary.period?.start && summary.period?.end
    ? `Period ${summary.period.start} to ${summary.period.end}`
    : 'Current inventory';
  let y = chrome.drawTitleBlock(
    doc,
    'Endpoint Management Review',
    summary.orgName ?? '',
    `${periodLabel} · Generated ${opts.generatedAt}${opts.partnerName ? ` · ${opts.partnerName}` : ''}`,
    PAGE.bandH + 10,
  );

  // Freshness, verbatim: each domain's note is one human sentence naming every
  // gap. An empty note means the snapshot is complete and inside its cadence.
  const notes = Object.entries(summary.freshness ?? {})
    .map(([domain, f]) => (f?.note ? `${domain}: ${f.note}` : ''))
    .filter((line) => line.length > 0);
  if (notes.length > 0) {
    for (const note of notes) {
      y = ensureSpace(doc, chrome, y, 10);
      y = drawProse(doc, chrome, note, y, 9, C.warning);
    }
  } else {
    const asOf = summary.freshness?.intune_devices?.asOf;
    if (asOf) y = drawProse(doc, chrome, `Intune inventory as of ${asOf}.`, y, 9, C.muted);
  }
  y += 1.5;

  // --- enrolment coverage ---------------------------------------------------
  y = ensureSpace(doc, chrome, y, 34);
  y = chrome.drawSectionHeading(doc, 'Enrolment coverage', y);
  y = drawTiles(doc, chrome, [
    { label: 'Devices enrolled in Intune', value: summary.enrolment?.intuneDevices },
    { label: 'Devices managed by Breeze', value: summary.enrolment?.breezeDevices },
    { label: 'Breeze devices with no Intune record', value: summary.enrolment?.breezeWithoutIntune },
    { label: 'Intune records not linked to a Breeze device', value: summary.enrolment?.intuneWithoutBreezeLink },
  ], y);

  if (typeof summary.enrolment?.intuneWithoutBreezeLink === 'number'
    && summary.enrolment.intuneWithoutBreezeLink > 0) {
    // Disclosed as a count only: these records carry no site, so listing them
    // would serve devices outside the reader's permitted sites.
    y = drawProse(
      doc,
      chrome,
      'Intune records that are not linked to a Breeze device are reported as a count only; '
      + 'they cannot be attributed to a site, so they are not listed individually.',
      y,
      8.6,
      C.muted,
    );
  }

  // --- compliance -----------------------------------------------------------
  y = ensureSpace(doc, chrome, y, 34);
  y = chrome.drawSectionHeading(doc, 'Compliance', y);
  const byState = summary.compliance?.byState ?? null;
  if (byState === null) {
    y = drawProse(
      doc,
      chrome,
      'Compliance was not measured for this period — see "What we could not measure" below. '
      + 'No figure is shown rather than a zero.',
      y,
      9,
      C.muted,
    );
  } else {
    y = drawTiles(
      doc,
      chrome,
      COMPLIANCE_STATES.map((state) => ({ label: COMPLIANCE_LABELS[state], value: byState[state] ?? 0 })),
      y,
    );
    // Every colour is paired with a word, so the split survives a mono print.
    const parts = COMPLIANCE_STATES
      .filter((state) => (byState[state] ?? 0) > 0)
      .map((state) => `${byState[state]} ${COMPLIANCE_LABELS[state].toLowerCase()}`);
    if (parts.length > 0) y = drawProse(doc, chrome, `${parts.join(', ')}.`, y, 8.8, C.muted);
  }

  const trend = summary.compliance?.trend ?? [];
  if (trend.length > 0) {
    y = ensureSpace(doc, chrome, y, 26);
    autoTable(doc, {
      startY: y,
      margin: { left: PAGE.mx, right: PAGE.mx },
      head: [['Date', 'Compliant', 'Not compliant', 'In grace', 'Unknown']],
      body: trend.map((p) => [p.date, num(p.compliant), num(p.noncompliant), num(p.inGrace), num(p.unknown)]),
      styles: { fontSize: 7.6, cellPadding: 1.4 },
      headStyles: { fillColor: C.primary, textColor: C.white },
      alternateRowStyles: { fillColor: C.zebra },
      didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
    y = drawProse(
      doc,
      chrome,
      'The trend comes from daily Microsoft 365 posture rollups — the only genuine history available.',
      y,
      8.4,
      C.muted,
    );
  }

  // --- devices --------------------------------------------------------------
  const listed = rows.filter((r) => r.complianceState !== 'compliant');
  if (listed.length > 0) {
    y = ensureSpace(doc, chrome, y, 26);
    y = chrome.drawSectionHeading(doc, 'Devices needing attention', y);
    autoTable(doc, {
      startY: y,
      margin: { left: PAGE.mx, right: PAGE.mx },
      head: [['Device', 'Operating system', 'Assigned to', 'Ownership', 'Last check-in', 'Compliance', 'Jailbroken']],
      body: listed.map((r) => [
        r.deviceName ?? '—',
        [r.operatingSystem, r.osVersion].filter(Boolean).join(' ') || '—',
        r.userPrincipalName ?? '—',
        r.ownerType ?? '—',
        r.lastIntuneSyncAt ?? 'Never',
        r.complianceState ? COMPLIANCE_LABELS[r.complianceState] : 'Unknown',
        r.jailBroken ?? '—',
      ]),
      styles: { fontSize: 7.4, cellPadding: 1.4 },
      headStyles: { fillColor: C.primary, textColor: C.white },
      alternateRowStyles: { fillColor: C.zebra },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 5) {
          const state = listed[data.row.index]?.complianceState ?? 'unknown';
          data.cell.styles.textColor = complianceColor(C, state);
        }
      },
      didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  }

  // --- stale enrolments -----------------------------------------------------
  y = ensureSpace(doc, chrome, y, 20);
  y = chrome.drawSectionHeading(doc, 'Stale enrolments', y);
  const staleCount = summary.staleEnrolments?.count;
  const thresholdDays = summary.staleEnrolments?.thresholdDays;
  y = drawProse(
    doc,
    chrome,
    typeof staleCount === 'number'
      ? `${staleCount} device${staleCount === 1 ? '' : 's'} have not checked in with Intune for `
        + `${thresholdDays ?? 14} days or more, or are no longer present in the tenant. `
        + 'Staleness is judged against the Intune sync cadence, not against the reporting period.'
      : 'Stale enrolments were not measured for this period — no figure is shown rather than a zero.',
    y,
    9,
    typeof staleCount === 'number' ? C.ink : C.muted,
  );

  // --- licence seats --------------------------------------------------------
  if (summary.licences !== undefined) {
    y = ensureSpace(doc, chrome, y, 26);
    y = chrome.drawSectionHeading(doc, 'Licence seats', y);
    const licences: LicenceSeatRow[] | null = summary.licences;
    if (licences === null) {
      y = drawProse(
        doc,
        chrome,
        'Licence seats were not measured for this period — no figure is shown rather than a zero.',
        y,
        9,
        C.muted,
      );
    } else if (licences.length === 0) {
      // Measured, and genuinely empty. Saying "not measured" here would be the
      // same class of lie as printing a zero for an unmeasured domain, just in
      // the other direction.
      y = drawProse(
        doc,
        chrome,
        'No active Microsoft 365 licence products were found for this tenant. This was measured, not skipped.',
        y,
        9,
        C.ink,
      );
    } else {
      autoTable(doc, {
        startY: y,
        margin: { left: PAGE.mx, right: PAGE.mx },
        head: [['Product', 'Seats in use', 'Seats purchased', 'In warning', 'Suspended', 'Status']],
        body: licences.map((l) => [
          l.skuPartNumber ?? '—',
          num(l.consumedUnits),
          num(l.prepaidEnabled),
          num(l.prepaidWarning),
          num(l.prepaidSuspended),
          l.capabilityStatus ?? '—',
        ]),
        styles: { fontSize: 7.6, cellPadding: 1.4 },
        headStyles: { fillColor: C.primary, textColor: C.white },
        alternateRowStyles: { fillColor: C.zebra },
        didDrawPage: () => { chrome.drawHeaderBand(doc); chrome.drawFooter(doc); },
      });
      y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
    }
  }

  // --- data gaps, then the caveat that must always appear -------------------
  y = drawDataGaps(doc, chrome, (summary.dataGaps ?? []).filter((g) => typeof g === 'string' && g.length > 0), y);

  if (summary.historyCaveat) {
    y = ensureSpace(doc, chrome, y, 18);
    y = chrome.drawSectionHeading(doc, 'About this report', y);
    drawProse(doc, chrome, summary.historyCaveat, y, 8.8, C.muted);
  }
}
