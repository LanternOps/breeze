import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { PostureSummary } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula } from '@/lib/csvExport';

// Re-export the shared CSV helpers so existing importers of these names from
// './reportExport' keep working; the canonical definitions now live in
// lib/csvExport (jsPDF-free so non-report exporters don't bundle a PDF library).
export { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula };
// PostureSummary is single-sourced in @breeze/shared (also consumed by the API
// generator that produces it); re-export so existing local importers still work.
export type { PostureSummary } from '@breeze/shared';

/** Convert an unknown cell value to a display string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Extract column headers and string[][] body from raw row objects. */
function extractTable(rows: unknown[]): { headers: string[]; body: string[][] } {
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const body = rows.map(row => {
    const record = row as Record<string, unknown>;
    return headers.map(h => cellToString(record[h]));
  });
  return { headers, body };
}

/** Trigger a browser file download from a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Return the browser's IANA timezone string. */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Export report rows as CSV, Excel (TSV with .xls extension), or PDF.
 *
 * Throws if rows is empty for CSV/Excel formats. When `summary` is supplied for
 * the security_compliance_posture report, the PDF leads with a posture scorecard
 * before the per-device table.
 */
export function exportReport(
  rows: unknown[],
  opts: {
    format: 'csv' | 'pdf' | 'excel';
    reportType: string;
    timezone: string;
    summary?: PostureSummary;
  }
): void {
  const { format, reportType, timezone, summary } = opts;
  const dateStr = new Date().toISOString().split('T')[0];
  const baseFilename = `${reportType}-report-${dateStr}`;

  if (format === 'csv') {
    if (rows.length === 0) throw new Error('No data to export');
    const { headers, body } = extractTable(rows);
    const csvContent = [
      headers.join(','),
      ...body.map(row =>
        row.map(escapeCsvCell).join(',')
      ),
    ].join('\n');
    downloadBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), `${baseFilename}.csv`);
    return;
  }

  if (format === 'excel') {
    if (rows.length === 0) throw new Error('No data to export');
    const { headers, body } = extractTable(rows);
    const tsvContent = [
      headers.join('\t'),
      ...body.map(row => row.map(escapeTsvCell).join('\t')),
    ].join('\n');
    downloadBlob(new Blob([tsvContent], { type: 'application/vnd.ms-excel' }), `${baseFilename}.xls`);
    return;
  }

  if (format !== 'pdf') {
    throw new Error(`Unsupported report format: ${format}`);
  }

  // PDF
  const title = reportType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const generatedAt = formatDateTime(new Date(), { timeZone: timezone });

  const doc = new jsPDF({ orientation: 'landscape' });

  // Security & Compliance Posture leads with a scorecard cover when a summary is present.
  let tableStartY = 34;
  if (reportType === 'security_compliance_posture' && summary) {
    tableStartY = renderPostureCover(doc, summary, generatedAt);
  } else {
    doc.setFontSize(18);
    doc.text(`${title} Report`, 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated: ${generatedAt}`, 14, 28);
  }

  if (rows.length > 0) {
    const { headers, body } = extractTable(rows);
    autoTable(doc, {
      startY: tableStartY,
      head: [headers],
      body,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
    });
  } else {
    doc.setTextColor(0);
    doc.setFontSize(12);
    doc.text('No data available', 14, tableStartY + 6);
  }

  downloadBlob(doc.output('blob'), `${baseFilename}.pdf`);
}

const yesNo = (v: boolean | undefined): string => (v ? 'Yes' : 'No');
// null/undefined = control was not assessed → "N/A", never a misleading "0%".
const pctText = (v: number | null | undefined): string => (v == null ? 'N/A — not assessed' : `${v}%`);
const withUnknown = (n: number | undefined): string => (n && n > 0 ? ` (${n} unknown)` : '');

/**
 * Render the posture scorecard cover (org header, control-coverage list,
 * privileged-access block, security-products list) and return the Y position
 * the per-device table should start at. Defensive: every field optional.
 */
function renderPostureCover(doc: jsPDF, summary: PostureSummary, generatedAt: string): number {
  const c = summary.controls ?? {};
  const p = summary.privilegedAccess ?? {};
  let y = 16;

  doc.setTextColor(0);
  doc.setFontSize(16);
  doc.text(`Security & Compliance Posture — ${summary.org?.name ?? ''}`.trim(), 14, y);
  y += 7;
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Generated: ${generatedAt}    Devices: ${summary.deviceCount ?? 0}`, 14, y);
  if (summary.postureScore != null) {
    y += 5;
    doc.text(`Overall posture score: ${summary.postureScore}/100`, 14, y);
  }

  doc.setTextColor(0);
  y += 9;
  doc.setFontSize(12);
  doc.text('Control coverage', 14, y);
  doc.setFontSize(9);
  const dnsStatus = c.dnsFilteringSyncStatus
    ? ` (sync: ${c.dnsFilteringSyncStatus})`
    : '';
  const controlLines = [
    `Managed EDR coverage: ${pctText(c.edrCoveragePct)}`,
    `Any AV + real-time protection: ${pctText(c.anyAvCoveragePct)}`,
    `Unprotected devices: ${c.unprotectedCount ?? 0}`,
    `AV definitions current: ${pctText(c.avDefinitionsCurrentPct)}`,
    `Disk encryption: ${pctText(c.encryptionPct)}`,
    `Host firewall: ${pctText(c.firewallPct)}`,
    `Patch current (no critical pending): ${pctText(c.patchCurrentPct)}${withUnknown(c.patchUnknownCount)}`,
    `Password complexity: ${pctText(c.passwordComplexityPct)}${withUnknown(c.passwordUnknownCount)}`,
    `Local-admin exposure (over threshold): ${pctText(c.localAdminExposurePct)}${withUnknown(c.localAdminUnknownCount)}`,
    `Identity provider connected (M365/Google): ${yesNo(c.identityProviderConnected)}`,
    `Backup configured: ${yesNo(c.backupConfigured)}${c.backupEncrypted ? ' (encrypted)' : ''}`,
    `DNS filtering active: ${yesNo(c.dnsFilteringActive)}${dnsStatus}`,
  ];
  // CIS hardening line is omitted entirely when the section is toggled off;
  // otherwise it shows the pass-rate with coverage, or "Not yet assessed".
  if (c.cisIncluded !== false) {
    const cisCoverage =
      c.cisAvgPassRate == null
        ? 'Not yet assessed'
        : `${c.cisAvgPassRate}% across ${c.cisAssessedCount ?? 0}/${summary.deviceCount ?? 0} devices assessed`;
    controlLines.push(`Hardening (CIS): ${cisCoverage}`);
  }
  for (const line of controlLines) {
    y += 5;
    doc.text(line, 18, y);
  }

  y += 9;
  doc.setFontSize(12);
  doc.text('Privileged access (PAM)', 14, y);
  doc.setFontSize(9);
  const pamLines = [
    `UAC interception: ${p.uacInterceptionEnabled ? 'Enabled' : 'Disabled'}`,
    `Active PAM rules: ${p.activePamRules ?? 0}`,
    `Elevations in window: ${p.elevationsInWindow ?? 0} — ${p.elevationsApproved ?? 0} approved / ${p.elevationsDenied ?? 0} denied`,
    `MFA step-up enforced: ${yesNo(p.mfaStepUpEnforced)}`,
  ];
  for (const line of pamLines) {
    y += 5;
    doc.text(line, 18, y);
  }

  const products = summary.securityProducts ?? [];
  if (products.length > 0) {
    y += 9;
    doc.setFontSize(12);
    doc.text('Security products in use', 14, y);
    doc.setFontSize(9);
    for (const prod of products) {
      y += 5;
      const coverage = prod.deviceCoverage != null ? ` — ${prod.deviceCoverage} devices` : '';
      const sync = prod.lastSyncStatus ? ` [sync: ${prod.lastSyncStatus}]` : '';
      const degraded = prod.active === false ? ' — DEGRADED' : '';
      doc.text(`${prod.product} (${prod.category})${coverage}${sync}${degraded}`, 18, y);
    }
  }

  // Put the per-device detail table on a fresh page for legibility.
  doc.addPage();
  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text('Per-device detail', 14, 16);
  return 22;
}
