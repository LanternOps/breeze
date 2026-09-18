/**
 * Threat Detection Review PDF (#5784 W02) — the service-plan evidence artifact
 * for a Huntress-monitored month.
 *
 * The reader is the customer's office manager, not a technician. Every number
 * is paired with a word, every colour with a label, and every unmeasured value
 * prints `N/A` with the reason beside it rather than a reassuring zero.
 *
 * Pure rendering over the persisted `ThreatDetectionSummary` snapshot: the
 * coverage sentence, the counts and the resolution statistics were all computed
 * at generation time, so an old snapshot re-renders identically. The design
 * system (header band, footer, title block, section headings) arrives through
 * `chrome` so this module never imports reportPdf.ts back and no cycle forms.
 *
 * TWO THINGS THIS FILE DELIBERATELY DOES NOT DO.
 *  - It does not claim a human reviewed anything. The title block says
 *    "generated review evidence"; the review record is the technician resolving
 *    the ticket.
 *  - It does not render the raw `details` jsonb, even if a legacy snapshot
 *    carried one. Only the named columns below are ever drawn.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  ThreatCoverage,
  ThreatDetectionSummary,
  ThreatIncidentRow,
} from '../types/threatDetectionReport';
import { SEVERITY_ORDER } from '../utils/threatDetection';

type RGB = [number, number, number];

/** The pieces of reportPdf.ts's design system this renderer needs. Structurally
 *  identical to hardwareLifecyclePdf.ts's — declared, not imported, for the
 *  same no-cycle reason. */
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

export type ThreatDetectionPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** The one string that stands for "we did not measure this". Never `0`. */
const NA = 'N/A';

function severityColor(C: PdfChrome['C'], severity: string | null): RGB {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical': return C.danger;
    case 'high': return C.danger;
    case 'medium': return C.warning;
    case 'low': return C.muted;
    default: return C.faint;
  }
}

function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : NA;
}

/** A measured count, or `N/A` — the whole point of the type's nullable counts. */
function measured(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? NA : `${value}${suffix}`;
}

function hoursLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return NA;
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
  return `${Math.round(value * 10) / 10} hrs`;
}

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

/** Wrapped body paragraph; returns the y below it. */
function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = wrapText(doc, text, width);
  const lineH = size * 0.56;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 2.5;
}

/** A row of "big number / label" tiles. A null value prints N/A, in muted ink,
 *  so an unmeasured tile is visually distinct from a measured zero. */
function drawTiles(
  doc: jsPDF,
  chrome: PdfChrome,
  tiles: Array<{ value: string; label: string; unmeasured?: boolean }>,
  y: number,
): number {
  const { C, PAGE } = chrome;
  if (tiles.length === 0) return y;
  const width = PAGE.w - PAGE.mx * 2;
  const tileW = width / tiles.length;
  tiles.forEach((tile, i) => {
    const x = PAGE.mx + i * tileW;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    ink(doc, tile.unmeasured ? C.faint : C.primary);
    doc.text(tile.value, x, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    ink(doc, C.muted);
    wrapText(doc, tile.label, tileW - 4).slice(0, 2).forEach((line, li) => {
      doc.text(line, x, y + 11 + li * 4);
    });
  });
  return y + 22;
}

/** The counts-by-bucket line, severity order preserved from the snapshot. */
function bucketLine(counts: Record<string, number> | null | undefined): string {
  if (!counts) return `${NA} — not measured`;
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'None recorded in the covered window';
  const known = (b: string) => (SEVERITY_ORDER as readonly string[]).indexOf(b);
  return entries
    .sort((a, b) => {
      const ra = known(a[0]) === -1 ? SEVERITY_ORDER.length : known(a[0]);
      const rb = known(b[0]) === -1 ? SEVERITY_ORDER.length : known(b[0]);
      return ra - rb || a[0].localeCompare(b[0]);
    })
    .map(([bucket, count]) => `${bucket}: ${count}`)
    .join('   ·   ');
}

function coverageMeta(coverage: ThreatCoverage | undefined, generatedAt: string): string {
  const period = coverage?.periodStart && coverage?.periodEnd
    ? `${dateOnly(coverage.periodStart)} to ${dateOnly(coverage.periodEnd)}`
    : 'an unstated period';
  return `Generated review evidence for ${period}   ·   Prepared ${generatedAt}`;
}

export function renderThreatDetectionReport(
  doc: jsPDF,
  summary: ThreatDetectionSummary,
  opts: ThreatDetectionPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const coverage = summary.coverage;
  // Only the named fields are ever read off a row: a legacy snapshot that
  // carried a raw `details` payload cannot leak it into the artifact.
  const rows: ThreatIncidentRow[] = Array.isArray(summary.rows) ? summary.rows : [];
  const incidents = summary.incidents;
  const agents = summary.agentCoverage;

  let y = chrome.drawTitleBlock(
    doc,
    'Threat Detection Review',
    summary.orgName ?? '',
    coverageMeta(coverage, opts.generatedAt),
    PAGE.bandH + 14,
  );

  // --- What this covers -------------------------------------------------------
  // First, before any number: the reader must know the window before they read
  // a count over it. `note` is printed verbatim — it is the one sentence the
  // shared `coverageGapLine` produced at generation time.
  y = chrome.drawSectionHeading(doc, 'What this covers', y + 6);
  const note = coverage?.note?.trim();
  y = drawProse(
    doc,
    chrome,
    note && note.length > 0
      ? note
      : 'The detection data held covers the whole of this period. This report enumerates what Breeze holds; it does not assert that a person reviewed each item.',
    y + 2,
    9.5,
    note ? C.danger : C.muted,
  );
  y = drawProse(
    doc,
    chrome,
    `Detection data held from ${dateOnly(coverage?.coveredFrom)} to ${dateOnly(coverage?.coveredTo)}   ·   Last sync ${dateOnly(coverage?.lastSyncAt)}${coverage?.lastSyncStatus ? ` (${coverage.lastSyncStatus})` : ''}`,
    y,
    8,
    C.muted,
  );

  // --- Endpoint coverage ------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Endpoint coverage', y + 4);
  y = drawTiles(doc, chrome, [
    { value: measured(agents?.huntressAgents), label: 'Endpoints with a detection agent', unmeasured: agents?.huntressAgents == null },
    { value: measured(agents?.breezeDevices), label: 'Devices Breeze manages', unmeasured: agents?.breezeDevices == null },
    { value: measured(agents?.devicesWithoutAgent), label: 'Managed devices with no detection agent', unmeasured: agents?.devicesWithoutAgent == null },
    { value: measured(agents?.agentsOffline), label: 'Detection agents not reporting in', unmeasured: agents?.agentsOffline == null },
  ], y + 2);

  // --- Detections -------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Detections in this period', y + 2);
  y = drawTiles(doc, chrome, [
    { value: measured(incidents?.opened), label: 'Detections raised', unmeasured: incidents?.opened == null },
    { value: measured(incidents?.resolved), label: 'Detections resolved', unmeasured: incidents?.resolved == null },
    { value: hoursLabel(incidents?.meanResolveHours), label: 'Average time to resolve', unmeasured: incidents?.meanResolveHours == null },
    { value: hoursLabel(incidents?.medianResolveHours), label: 'Typical time to resolve', unmeasured: incidents?.medianResolveHours == null },
  ], y + 2);
  y = drawProse(doc, chrome, `By severity — ${bucketLine(incidents?.bySeverity)}`, y, 8.4, C.muted);
  y = drawProse(doc, chrome, `By status — ${bucketLine(incidents?.byStatus)}`, y, 8.4, C.muted);

  // --- The detections themselves ----------------------------------------------
  if (rows.length > 0) {
    y = chrome.drawSectionHeading(doc, 'Detections', y + 3);
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [['Reported', 'Device', 'Severity', 'Detection', 'Status', 'Resolved', 'What we advised']],
      body: rows.map((r) => [
        dateOnly(r.reportedAt),
        r.hostname ?? 'Unattributed',
        r.severity ?? 'unknown',
        [r.title ?? 'Detection', r.carriedIn ? '(opened before this period)' : ''].filter(Boolean).join(' '),
        r.status ?? 'unknown',
        r.resolvedAt ? dateOnly(r.resolvedAt) : 'Not yet',
        r.recommendation ?? '',
      ]),
      styles: { font: 'helvetica', fontSize: 7.4, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      columnStyles: {
        0: { cellWidth: 20 }, 1: { cellWidth: 32 }, 2: { cellWidth: 18 },
        4: { cellWidth: 20 }, 5: { cellWidth: 20 },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 2) {
          data.cell.styles.textColor = severityColor(C, String(data.cell.raw ?? ''));
          data.cell.styles.fontStyle = 'bold';
        }
      },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  } else {
    y = chrome.drawSectionHeading(doc, 'Detections', y + 3);
    y = drawProse(
      doc,
      chrome,
      incidents?.opened == null
        ? 'No detection data was available for this period, so no detections can be listed. This is an absence of measurement, not an absence of threats.'
        : 'No detections were raised in the covered window.',
      y + 1,
      9.5,
      incidents?.opened == null ? C.danger : C.muted,
    );
  }

  // --- Still open from earlier periods -----------------------------------------
  // Three distinct states, and the reader is told which: a measured count, a
  // section the report was configured not to look at, and a genuine inability
  // to measure. Printing nothing for the last two would let "we did not look"
  // and "there are none" read identically.
  const carriedInIncluded = coverage?.carriedInIncluded !== false;
  if (incidents?.carriedIn !== null && incidents?.carriedIn !== undefined) {
    y = drawProse(
      doc,
      chrome,
      `${incidents.carriedIn} detection(s) opened before this period were still unresolved at generation time and are included above where listed.`,
      y,
      8.4,
      C.muted,
    );
  } else if (!carriedInIncluded) {
    y = drawProse(
      doc,
      chrome,
      'This report was set not to look for detections that opened before the period, so none are listed above. That is a setting, not a finding.',
      y,
      8.4,
      C.muted,
    );
  } else {
    y = drawProse(
      doc,
      chrome,
      'Detections carried in from earlier periods could not be measured, so none are listed above.',
      y,
      8.4,
      C.danger,
    );
  }

  // --- Every gap, restated where the reader ends -------------------------------
  const gaps = Array.isArray(summary.dataGaps) ? summary.dataGaps.filter(Boolean) : [];
  if (gaps.length > 0) {
    y = chrome.drawSectionHeading(doc, 'Limits of this report', y + 2);
    for (const gap of gaps) {
      y = drawProse(doc, chrome, gap, y + 1, 8.6, C.muted);
    }
  }
}
