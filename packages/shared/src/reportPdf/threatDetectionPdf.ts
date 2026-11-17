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
import { autoTable } from 'jspdf-autotable';
import type {
  ThreatCoverage,
  ThreatDetectionSummary,
  ThreatIncidentRow,
} from '../types/threatDetectionReport';
import { SEVERITY_ORDER } from '../utils/threatDetection';
import {
  clientDetectionTitle,
  endpointCoverageCounts,
  openForDays,
  threatSeverityLabel,
  threatStatusLabel,
} from '../utils/threatDetectionDisplay';

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

/** Same palette as the Vulnerability Management report's severity tiles, so a
 *  client reading both sees one colour per severity (#12046). */
function severityColor(C: PdfChrome['C'], severity: string | null): RGB {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical': return C.danger;
    case 'high': return C.warning;
    case 'medium': return C.primary;
    case 'low': return C.muted;
    default: return C.faint;
  }
}

/** An unresolved detection older than this is called out under the table: it
 *  may have been closed at the source without the closure reaching Breeze. */
const LONG_OPEN_DAYS = 90;

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

/**
 * The counts-by-bucket line, severity order preserved from the snapshot. Each
 * stored bucket is printed through `label` (client words, never a raw token),
 * and buckets that share a label are merged — `sent` and `open` are both
 * "Open" — so one word never appears twice.
 */
function bucketLine(
  counts: Record<string, number> | null | undefined,
  label: (bucket: string) => string,
): string {
  if (!counts) return `${NA} — not measured`;
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'None recorded in the covered window';
  const known = (b: string) => (SEVERITY_ORDER as readonly string[]).indexOf(b.toLowerCase());
  const merged = new Map<string, number>();
  entries
    .sort((a, b) => {
      const ra = known(a[0]) === -1 ? SEVERITY_ORDER.length : known(a[0]);
      const rb = known(b[0]) === -1 ? SEVERITY_ORDER.length : known(b[0]);
      return ra - rb || a[0].localeCompare(b[0]);
    })
    .forEach(([bucket, count]) => {
      const word = label(bucket);
      merged.set(word, (merged.get(word) ?? 0) + count);
    });
  return [...merged.entries()].map(([word, count]) => `${word}: ${count}`).join('   ·   ');
}

/** Same shape as the other service-plan reports' title meta (#12046). */
function coverageMeta(coverage: ThreatCoverage | undefined, generatedAt: string): string {
  const period = coverage?.periodStart && coverage?.periodEnd
    ? `Reporting period ${dateOnly(coverage.periodStart)} to ${dateOnly(coverage.periodEnd)}`
    : 'Reporting period not stated';
  return `${period}  |  Generated ${generatedAt}  |  Automatically generated review evidence`;
}

/** Statuses that close a detection even when the source sent no closure date
 *  — such a row must not read "Open N days" beside "Resolved". */
const CLOSED_STATUS_LABELS = new Set(['Resolved', 'Dismissed']);

function isClosedWithoutDate(row: ThreatIncidentRow): boolean {
  return !row.resolvedAt && CLOSED_STATUS_LABELS.has(threatStatusLabel(row.status));
}

function isLongOpen(row: ThreatIncidentRow | undefined, asOf: string | undefined): boolean {
  if (!row || row.resolvedAt || isClosedWithoutDate(row)) return false;
  const days = openForDays(row.reportedAt, asOf);
  return days !== null && days > LONG_OPEN_DAYS;
}

/** The Resolved cell: a date, or how long the detection has been open. */
function resolvedCell(row: ThreatIncidentRow, asOf: string | undefined): string {
  if (row.resolvedAt) return dateOnly(row.resolvedAt);
  if (isClosedWithoutDate(row)) return 'Not recorded';
  const days = openForDays(row.reportedAt, asOf);
  if (days === null) return 'Not resolved';
  return `Open ${days} day${days === 1 ? '' : 's'}`;
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
    PAGE.bandH + 8,
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
  // #12046: the three device tiles reconcile — with + without = managed. The
  // agent total is NOT a tile: it counts every agent the detection service
  // holds for the org, including ones matched to no managed device, so it does
  // not belong beside device counts. It is stated in words below instead.
  const fleet = endpointCoverageCounts(agents);
  y = chrome.drawSectionHeading(doc, 'Endpoint coverage', y + 4);
  y = drawTiles(doc, chrome, [
    { value: measured(fleet.managed), label: 'Devices Breeze manages', unmeasured: fleet.managed == null },
    { value: measured(fleet.withAgent), label: 'Managed devices with a detection agent', unmeasured: fleet.withAgent == null },
    { value: measured(fleet.withoutAgent), label: 'Managed devices with no detection agent', unmeasured: fleet.withoutAgent == null },
    { value: measured(agents?.agentsOffline), label: 'Detection agents not reporting in', unmeasured: agents?.agentsOffline == null },
  ], y + 2);
  if (fleet.agentsReported != null && fleet.unmatchedAgents != null && fleet.unmatchedAgents > 0) {
    y = drawProse(
      doc,
      chrome,
      `${fleet.unmatchedAgents} of the ${fleet.agentsReported} detection agents reported for this organization are not matched to a device Breeze manages, so they are not counted in the tiles above.`,
      y - 4,
      8.4,
      C.muted,
    ) + 4;
  } else if (fleet.agentsReported != null && fleet.unmatchedAgents == null && fleet.withAgent != null) {
    // A legacy snapshot (before #12046): its device pair counts Huntress
    // agents only, so it says so. The unmatched count was never recorded, and
    // two agents can share one device, so it is not guessed from the totals.
    y = drawProse(
      doc,
      chrome,
      `These device counts include Huntress agents only. ${fleet.agentsReported} Huntress agent${fleet.agentsReported === 1 ? ' is' : 's are'} reported for this organization; any not matched to a device Breeze manages are not counted in the tiles above.`,
      y - 4,
      8.4,
      C.muted,
    ) + 4;
  }
  // EDR provider framework (#8164): printed only when the snapshot carries it,
  // so a no-EDR (or legacy) snapshot renders exactly as before. The vendor is
  // never named — this is a customer-facing artifact.
  if (agents?.edrEndpoints != null) {
    y = drawProse(
      doc,
      chrome,
      `Managed endpoint protection: ${agents.edrEndpoints} endpoint${agents.edrEndpoints === 1 ? '' : 's'} reporting to a protection console`,
      y - 4,
      8.4,
      C.muted,
    );
  }

  // --- Detections -------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Detections in this period', y + 2);
  y = drawTiles(doc, chrome, [
    { value: measured(incidents?.opened), label: 'Detections raised', unmeasured: incidents?.opened == null },
    { value: measured(incidents?.resolved), label: 'Detections resolved', unmeasured: incidents?.resolved == null },
    { value: hoursLabel(incidents?.meanResolveHours), label: 'Average time to resolve', unmeasured: incidents?.meanResolveHours == null },
    { value: hoursLabel(incidents?.medianResolveHours), label: 'Median time to resolve', unmeasured: incidents?.medianResolveHours == null },
  ], y + 2);
  y = drawProse(doc, chrome, `By severity — ${bucketLine(incidents?.bySeverity, threatSeverityLabel)}`, y, 8.4, C.muted);
  y = drawProse(doc, chrome, `By status — ${bucketLine(incidents?.byStatus, threatStatusLabel)}`, y, 8.4, C.muted);
  if (summary.edrDetections) {
    y = drawProse(
      doc,
      chrome,
      `Managed endpoint protection detections open now: ${summary.edrDetections.open}   ·   ${bucketLine(summary.edrDetections.bySeverity, threatSeverityLabel)}`,
      y,
      8.4,
      C.muted,
    );
  }

  // --- The detections themselves ----------------------------------------------
  if (rows.length > 0) {
    // An open detection's age is measured against generation time — the
    // instant the snapshot was taken — never "now" at re-render, so an old
    // snapshot re-renders identically.
    const asOf = summary.generatedAt ?? coverage?.generatedAt;
    // An all-empty advice column is noise; it is drawn only when some row has
    // advice. It is the LAST column, so dropping it shifts no other index.
    const hasAdvice = rows.some((r) => typeof r.recommendation === 'string' && r.recommendation.trim() !== '');
    const head = ['Reported', 'Device', 'Severity', 'Detection', 'Status', 'Resolved'];
    if (hasAdvice) head.push('What we advised');
    y = chrome.drawSectionHeading(doc, 'Detections', y + 3);
    autoTable(doc, {
      startY: y + 1,
      margin: { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 },
      head: [head],
      body: rows.map((r) => {
        const cells = [
          dateOnly(r.reportedAt),
          r.hostname ?? 'Unattributed',
          threatSeverityLabel(r.severity),
          [clientDetectionTitle(r.title, summary.orgName), r.carriedIn ? '(opened before this period)' : '']
            .filter(Boolean).join(' '),
          threatStatusLabel(r.status),
          resolvedCell(r, asOf),
        ];
        if (hasAdvice) cells.push(r.recommendation ?? '');
        return cells;
      }),
      styles: { font: 'helvetica', fontSize: 7.4, cellPadding: 1.8, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
      headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.zebra },
      columnStyles: {
        0: { cellWidth: 20 }, 1: { cellWidth: 32 }, 2: { cellWidth: 18 },
        4: { cellWidth: 28 }, 5: { cellWidth: 24 },
      },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        if (data.column.index === 2) {
          data.cell.styles.textColor = severityColor(C, String(data.cell.raw ?? ''));
          data.cell.styles.fontStyle = 'bold';
        }
        if (data.column.index === 5 && isLongOpen(rows[data.row.index], asOf)) {
          data.cell.styles.textColor = C.danger;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      didDrawPage: () => {
        chrome.drawHeaderBand(doc);
        chrome.drawFooter(doc);
      },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
    // Flag age rather than list a months-old open detection silently: it is
    // either genuinely open or a closure that never reached Breeze, and the
    // reader is owed a sentence either way.
    const longOpen = rows.filter((r) => isLongOpen(r, asOf)).length;
    if (longOpen > 0) {
      y = drawProse(
        doc,
        chrome,
        `${longOpen} detection${longOpen === 1 ? ' has' : 's have'} been open for more than ${LONG_OPEN_DAYS} days. A detection this old may have been closed at the source without the closure reaching this report; your technician will confirm its status.`,
        y,
        8.4,
        C.danger,
      );
    }
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
