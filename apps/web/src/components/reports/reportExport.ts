import type { PostureSummary } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula } from '@/lib/csvExport';
import { sanitizeImageSrc } from '@/lib/safeImageSrc';
import { fetchWithAuth } from '../../stores/auth';
import { buildReportPdf, type ReportBranding } from './reportPdf';

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
 * before the per-device table. PDFs are branded with the partner's uploaded logo
 * when available (fetched here unless `branding` is supplied by the caller).
 */
export async function exportReport(
  rows: unknown[],
  opts: {
    format: 'csv' | 'pdf' | 'excel';
    reportType: string;
    timezone: string;
    summary?: PostureSummary;
    /** Pre-resolved partner branding; loaded automatically for PDFs when omitted. */
    branding?: ReportBranding;
  }
): Promise<void> {
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

  // PDF — branded scorecard cover (posture) or branded generic table.
  const generatedAt = formatDateTime(new Date(), { timeZone: timezone });
  const branding = opts.branding ?? (await loadPartnerBranding());
  const doc = buildReportPdf(rows, { reportType, generatedAt, timezone, summary, branding });
  downloadBlob(doc.output('blob'), `${baseFilename}.pdf`);
}

/**
 * Load a same-origin/CORS-enabled image and re-encode it as a PNG data URL so
 * jsPDF can embed it. Returns the data URL plus intrinsic aspect ratio, or null
 * on any failure (missing, blocked by CORS, decode error) so the caller falls
 * back to the Breeze vector mark.
 */
function loadImageAsPng(url: string): Promise<{ dataUrl: string; aspect: number } | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas.width || !canvas.height) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), aspect: canvas.width / canvas.height });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Fetch the current partner's branding (name + uploaded logo) for report
 * headers. Never throws — any failure yields an unbranded result so export
 * still succeeds with the Breeze fallback mark.
 */
export async function loadPartnerBranding(): Promise<ReportBranding> {
  const empty: ReportBranding = { name: null, logoDataUrl: null, logoAspect: null };
  try {
    const res = await fetchWithAuth('/orgs/partners/me');
    if (!res.ok) return empty;
    const data = (await res.json()) as {
      name?: string;
      settings?: { branding?: { logoUrl?: string } };
    };
    const name = data.name ?? null;
    const safeLogoUrl = sanitizeImageSrc(data.settings?.branding?.logoUrl ?? null);
    if (!safeLogoUrl) return { name, logoDataUrl: null, logoAspect: null };
    const loaded = await loadImageAsPng(safeLogoUrl);
    return { name, logoDataUrl: loaded?.dataUrl ?? null, logoAspect: loaded?.aspect ?? null };
  } catch {
    return empty;
  }
}
