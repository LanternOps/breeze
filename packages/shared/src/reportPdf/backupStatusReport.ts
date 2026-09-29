/**
 * Backup status report PDF — the Cove "Backup & Recovery: All devices" email
 * layout, over both sources (Breeze + provider). Reuses reportPdf.ts's design
 * system through `chrome` (header band, footer, title block, section
 * heading) exactly like `hardwareLifecyclePdf.ts`, and its `PdfChrome` type
 * verbatim — this module never imports reportPdf.ts back.
 */
import type { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';
import type { PdfChrome } from './hardwareLifecyclePdf';
import type { BackupStatusReportData } from '../types/backupStatusReport';
import type {
  BackupHealthRow,
  BackupRecency,
  ExternalBackupStatus,
} from '../types/backupHealth';
import type { BackupStatusBucketId } from '../utils/backupHealth';

type RGB = [number, number, number];

const fill = (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;

// Six buckets — the shared W01 `BACKUP_STATUS_BUCKET_IDS` grouping (see
// apps/api/src/services/backupStatusReport.ts's `buildStatusBuckets`, which
// this renderer's `data.statusBuckets` input already came from). `other` is
// the catch-all for `not_started`/`unknown` and is simply absent from
// `data.statusBuckets` when its count is zero — `drawBucketBar` below already
// skips any zero-count entry generically, so no extra omission logic is
// needed here, only the label/colour for when it IS present.
const STATUS_BUCKET_LABEL: Record<BackupStatusBucketId, string> = {
  no_backups: 'No backups',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  in_progress: 'In process',
  unsuccessful: 'Unsuccessful',
  other: 'Other',
};

const RECENCY_BUCKET_LABEL: Record<BackupRecency, string> = {
  never: 'Never',
  under_24h: 'Under 24 hours',
  under_48h: 'Under 48 hours',
  over_48h: 'Over 48 hours',
};

function statusBucketColor(C: PdfChrome['C'], key: BackupStatusBucketId): RGB {
  switch (key) {
    case 'no_backups': return C.faint;
    case 'completed': return C.success;
    case 'completed_with_errors': return C.warning;
    case 'in_progress': return C.primary;
    case 'unsuccessful': return C.danger;
    case 'other': return C.muted;
    default: return C.faint;
  }
}

function recencyBucketColor(C: PdfChrome['C'], key: BackupRecency): RGB {
  switch (key) {
    case 'under_24h': return C.success;
    case 'under_48h': return C.warning;
    case 'over_48h': return C.danger;
    case 'never': return C.danger;
    default: return C.faint;
  }
}

/**
 * One horizontal bar per bucket group: label + count on top, a proportional
 * segment strip below — the same visual language as
 * `hardwareLifecyclePdf.ts`'s `drawStatusBar`, generalized over an arbitrary
 * bucket list and colour function since this report draws TWO such bars
 * (status, then recency) rather than one.
 */
function drawBucketBar<K extends string>(
  doc: jsPDF,
  chrome: PdfChrome,
  buckets: { key: K; count: number; pct: number }[],
  label: (key: K) => string,
  color: (key: K) => RGB,
  y: number,
): number {
  const { C, PAGE } = chrome;
  const visible = buckets.filter((b) => b.count > 0);
  const total = buckets.reduce((a, b) => a + b.count, 0);
  const width = PAGE.w - PAGE.mx * 2;
  const labelH = 11;
  const barH = 6;
  const barY = y + labelH + 1.5;
  if (total === 0 || visible.length === 0) {
    fill(doc, C.rule);
    doc.rect(PAGE.mx, barY, width, barH, 'F');
    return barY + barH + 3;
  }
  const gap = 0.6;
  const usable = width - gap * (visible.length - 1);
  const slot = width / visible.length;
  let x = PAGE.mx;
  for (const [i, b] of visible.entries()) {
    const w = usable * (b.count / total);
    const lx = PAGE.mx + slot * i;
    const c = color(b.key);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    ink(doc, c);
    const num = String(b.count);
    doc.text(num, lx, y + 7);
    const nw = doc.getTextWidth(num);
    doc.setFontSize(8.5);
    ink(doc, C.ink);
    doc.text(`${label(b.key)} (${b.pct}%)`, lx + nw + 2.2, y + 3.4);
    fill(doc, mix(c, C.white, 0.82));
    doc.rect(x, barY, w, barH - 1.1, 'F');
    fill(doc, c);
    doc.rect(x, barY + barH - 1.1, w, 1.1, 'F');
    x += w + gap;
  }
  return barY + barH + 3;
}

/** Per-day colour for the 28-day cell strip: green completed, amber warning
 *  statuses, red critical statuses, grey no observation (`status === null`)
 *  or a status this report treats as neither a pass nor a fail for a SINGLE
 *  day (`in_progress`/`not_started`/`unknown` — a day mid-run or unclassified
 *  is not a health claim the way it is once aggregated into `health` over the
 *  whole row). */
function dayCellColor(C: PdfChrome['C'], status: ExternalBackupStatus | null): RGB {
  if (status === null) return C.rule;
  switch (status) {
    case 'completed': return C.success;
    case 'completed_with_errors':
    case 'interrupted': return C.warning;
    case 'failed':
    case 'over_quota':
    case 'no_selection':
    case 'no_backups': return C.danger;
    default: return C.rule;
  }
}

function drawHistoryCell(doc: jsPDF, chrome: PdfChrome, row: BackupHealthRow, data: CellHookData): void {
  const { C } = chrome;
  const padX = 1;
  const x = data.cell.x + padX;
  const w = data.cell.width - padX * 2;
  const h = data.cell.height - 2.6;
  const y = data.cell.y + 1.3;
  // Right-align a shorter history to "today" so a newly linked device's few
  // observed days still line up with every other row's rightmost cell.
  const days = row.history28d.slice(-28);
  const cellW = w / 28;
  const offset = 28 - days.length;
  for (let i = 0; i < offset; i += 1) {
    fill(doc, C.rule);
    doc.rect(x + i * cellW, y, Math.max(cellW - 0.2, 0.3), h, 'F');
  }
  days.forEach((d, i) => {
    fill(doc, dayCellColor(C, d.status));
    doc.rect(x + (offset + i) * cellW, y, Math.max(cellW - 0.2, 0.3), h, 'F');
  });
}

type Col = { key: string; label: string; w: number; halign: 'left' | 'right' | 'center' };
const COLUMNS: Col[] = [
  { key: 'device', label: 'Device', w: 36, halign: 'left' },
  { key: 'computerName', label: 'Computer name', w: 26, halign: 'left' },
  { key: 'organization', label: 'Organization', w: 28, halign: 'left' },
  { key: 'source', label: 'Source', w: 36, halign: 'left' },
  { key: 'type', label: 'Type', w: 22, halign: 'left' },
  { key: 'dataSources', label: 'Data sources', w: 26, halign: 'left' },
  { key: 'selected', label: 'Selected', w: 18, halign: 'right' },
  { key: 'used', label: 'Used', w: 18, halign: 'right' },
  { key: 'history', label: '28 days', w: 36, halign: 'left' },
  { key: 'status', label: 'Status', w: 24, halign: 'left' },
  { key: 'errors', label: 'Errors', w: 13, halign: 'right' },
];
const STATUS_COL = COLUMNS.findIndex((c) => c.key === 'status');
const HISTORY_COL = COLUMNS.findIndex((c) => c.key === 'history');

const BODY_FONT = 7.5;
const ROW_MIN_H = 8.4;

function formatBytes(n: number | null): string {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}

const STATUS_LABEL: Record<ExternalBackupStatus, string> = {
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
  in_progress: 'In process',
  interrupted: 'Interrupted',
  over_quota: 'Over quota',
  no_selection: 'Nothing selected',
  not_started: 'Not started',
  no_backups: 'No backups',
  unknown: 'Unknown',
};

function statusColor(C: PdfChrome['C'], status: ExternalBackupStatus): RGB {
  switch (status) {
    case 'completed': return C.success;
    case 'completed_with_errors':
    case 'interrupted': return C.warning;
    case 'failed':
    case 'over_quota':
    case 'no_selection':
    case 'no_backups': return C.danger;
    default: return C.faint;
  }
}

function cellText(row: BackupHealthRow, key: string): string {
  switch (key) {
    case 'device': return row.name;
    case 'computerName': return row.computerName ?? '-';
    case 'organization': return row.orgName;
    case 'source': return row.source === 'breeze' ? 'Breeze' : (row.providerLabel ?? 'Provider');
    case 'type': return row.osType === 'workstation' ? 'Workstation' : row.osType === 'server' ? 'Server' : 'Unknown';
    case 'dataSources': return row.dataSources.length > 0 ? row.dataSources.join(', ') : '-';
    case 'selected': return formatBytes(row.selectedBytes);
    case 'used': return formatBytes(row.usedBytes);
    case 'errors': return String(row.errorsCount);
    case 'status': return STATUS_LABEL[row.status];
    // Drawn by hand in didDrawCell (a 28-cell colour strip); text stays empty
    // so autoTable never prints a stray label under the drawing.
    case 'history':
    default: return '';
  }
}

function ensureSpace(doc: jsPDF, chrome: PdfChrome, y: number, needed: number): number {
  if (y + needed <= chrome.PAGE.footY - 6) return y;
  doc.addPage();
  chrome.drawHeaderBand(doc);
  chrome.drawFooter(doc);
  return chrome.PAGE.bandH + 10;
}

export type BackupStatusPdfOpts = {
  generatedAt: string;
};

export function renderBackupStatusReport(
  doc: jsPDF,
  data: BackupStatusReportData,
  opts: BackupStatusPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const rows = Array.isArray(data.rows) ? data.rows : [];

  let y = chrome.drawTitleBlock(
    doc,
    'Backup Status Report',
    data.org?.name ?? '',
    `Prepared ${opts.generatedAt} - ${rows.length} device${rows.length === 1 ? '' : 's'} across both sources`,
    PAGE.bandH + 14,
  );

  // --- Status ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Status', y + 6);
  y = drawBucketBar(doc, chrome, data.statusBuckets, (k) => STATUS_BUCKET_LABEL[k], (k) => statusBucketColor(C, k), y + 2);

  // --- Last successful backup ----------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Last successful backup', y + 6);
  y = drawBucketBar(doc, chrome, data.recencyBuckets, (k) => RECENCY_BUCKET_LABEL[k], (k) => recencyBucketColor(C, k), y + 2);

  // --- Devices ---------------------------------------------------------------
  if (rows.length === 0) {
    y = chrome.drawSectionHeading(doc, 'Devices', y + 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    ink(doc, C.muted);
    doc.text("No devices matched this report's scope and filters.", PAGE.mx, y + 4);
    return;
  }

  y = ensureSpace(doc, chrome, y + 8, 20 + ROW_MIN_H * Math.min(3, rows.length));
  y = chrome.drawSectionHeading(doc, 'Devices', y);
  const contentW = PAGE.w - PAGE.mx * 2;
  const scale = contentW / COLUMNS.reduce((a, c) => a + c.w, 0);
  const columnStyles: Record<number, { cellWidth: number; halign: Col['halign'] }> = {};
  COLUMNS.forEach((c, i) => { columnStyles[i] = { cellWidth: c.w * scale, halign: c.halign }; });
  const continuationTop = PAGE.bandH + 16;

  autoTable(doc, {
    startY: y + 1,
    margin: { top: continuationTop, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
    head: [COLUMNS.map((c) => ({ content: c.label, styles: { halign: c.halign } }))],
    body: rows.map((r) => COLUMNS.map((c) => cellText(r, c.key))),
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: BODY_FONT, cellPadding: { top: 1.2, bottom: 1.2, left: 1.6, right: 1.6 }, minCellHeight: ROW_MIN_H, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
    headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold', fontSize: 6.8, lineColor: C.rule, lineWidth: 0.1, minCellHeight: 7 },
    alternateRowStyles: { fillColor: C.zebra },
    columnStyles,
    didParseCell: (cell: CellHookData) => {
      if (cell.section !== 'body') return;
      const row = rows[cell.row.index];
      if (!row) return;
      if (cell.column.index === STATUS_COL) {
        cell.cell.styles.textColor = statusColor(C, row.status);
        cell.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawCell: (cell: CellHookData) => {
      if (cell.section !== 'body') return;
      const row = rows[cell.row.index];
      if (!row) return;
      if (cell.column.index === HISTORY_COL) drawHistoryCell(doc, chrome, row, cell);
    },
    didDrawPage: (info) => {
      if (info.pageNumber <= 1) return;
      chrome.drawHeaderBand(doc);
      chrome.drawFooter(doc);
      chrome.drawSectionHeading(doc, 'Devices (continued)', PAGE.bandH + 10);
    },
  });

  const t = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  const finalY = typeof t?.finalY === 'number' ? t.finalY : y;

  const truncatedNote = data.truncated
    ? ' Row limit reached: the device list is cut short and does not cover every device.'
    : '';
  const note = `Figures as of ${data.asOf}. "28 days" reads oldest (left) to most recent (right); grey is a day with no observation.${truncatedNote}`;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  ink(doc, C.faint);
  const noteY = finalY + 4 <= PAGE.footY - 6 ? finalY + 4 : PAGE.footY - 2.5;
  doc.text(note, PAGE.mx, noteY);
}
