import type { PostureSummary, ExecutiveSummary, OrgNarrativeReportSummary, FleetDesignReportSummary,
  EndpointManagementSummary,
  VulnerabilityManagementSummary,
  IdentityAccessSummary,
} from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula } from '@/lib/csvExport';
import { downloadBlob } from '@/lib/downloadBlob';
import { sanitizeImageSrc } from '@/lib/safeImageSrc';
import { fetchWithAuth } from '../../stores/auth';
import { buildReportPdf, parseHexColor, type ReportBranding } from '@breeze/shared/reportPdf';

// Re-export the shared CSV + download helpers so existing importers of these
// names from './reportExport' keep working; the canonical definitions now live
// in lib/csvExport and lib/downloadBlob (both jsPDF-free, so a non-report
// exporter such as the quote order breakdown doesn't bundle a PDF library).
export { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula, downloadBlob };
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

/** Return the browser's IANA timezone string. */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Export report rows as CSV, Excel (TSV with .xls extension), or PDF.
 *
 * Throws if rows is empty for CSV/Excel formats. When `summary` is supplied for
 * the security_compliance_posture report, the PDF leads with a posture scorecard
 * before the per-device table; for ai_org_narrative it renders the stored
 * narrative instead of a table. PDFs are branded with the partner's uploaded
 * logo when available (fetched here unless `branding` is supplied by the caller).
 */
export async function exportReport(
  rows: unknown[],
  opts: {
    format: 'csv' | 'pdf' | 'excel';
    reportType: string;
    timezone: string;
    /** Stored run snapshot consumed by the designed cover/body renderers
     * (posture scorecard, executive summary, AI org narrative, Fleet
     * Design); the generic table path ignores it. */
    // #5784 W03: widened so the staff/browser export path passes the DESIGNED
    // summary through to buildReportPdf's endpoint-management arm. Without it
    // the summary is dropped and the PDF silently degrades to the generic
    // row table.
    // #5784 W06. Further widened so the same path passes the DESIGNED identity
    // summary — and its caveats — through to buildReportPdf's identity arm. A
    // summary that does not typecheck here gets dropped at the call site, and
    // the PDF silently falls through to the generic renderer, keeping the
    // sign-in rows while losing every limit printed alongside them.
    summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary | EndpointManagementSummary | VulnerabilityManagementSummary | IdentityAccessSummary;
    /** Slim baseline from the previous completed run (report_runs.result.previous),
     * used to draw the scorecard trend chip; ignored by non-cover report types. */
    previous?: { generatedAt?: string | null; summary?: unknown };
    /** Pre-resolved partner branding; loaded automatically for PDFs when omitted. */
    branding?: ReportBranding;
  }
): Promise<void> {
  const { format, reportType, timezone, summary, previous } = opts;
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
  // Medium date + short time ("Jul 1, 2026, 4:15 PM"): an outward-facing
  // document doesn't need seconds precision.
  const generatedAt = formatDateTime(new Date(), {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const branding = opts.branding ?? (await loadPartnerBranding());
  const doc = buildReportPdf(rows, { reportType, generatedAt, timezone, summary, previous, branding });
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
      settings?: { branding?: { logoUrl?: string; primaryColor?: string; secondaryColor?: string }; contact?: { name?: string; email?: string } };
    };
    const name = data.name ?? null;
    const colors = {
      primaryColor: parseHexColor(data.settings?.branding?.primaryColor) ? data.settings!.branding!.primaryColor! : null,
      accentColor: parseHexColor(data.settings?.branding?.secondaryColor) ? data.settings!.branding!.secondaryColor! : null,
      contactEmail: data.settings?.contact?.email?.trim() || null,
      contactName: data.settings?.contact?.name?.trim() || null,
    };
    const safeLogoUrl = sanitizeImageSrc(data.settings?.branding?.logoUrl ?? null);
    if (!safeLogoUrl) return { name, logoDataUrl: null, logoAspect: null, ...colors };
    const loaded = await loadImageAsPng(safeLogoUrl);
    return { name, logoDataUrl: loaded?.dataUrl ?? null, logoAspect: loaded?.aspect ?? null, ...colors };
  } catch {
    return empty;
  }
}
