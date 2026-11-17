import { jsPDF } from 'jspdf';
import { autoTable, type CellHookData } from 'jspdf-autotable';
import type { PostureControls, PostureProduct, PostureSummary } from '../types/postureReport';
import type { ExecutiveSummary } from '../types/executiveSummaryReport';
import type { HardwareLifecycleSummary } from '../types/hardwareLifecycleReport';
import { renderHardwareLifecycleReport } from './hardwareLifecyclePdf';
import type { BackupStatusReportData } from '../types/backupStatusReport';
import { renderBackupStatusReport } from './backupStatusReport';
import type { ThreatDetectionSummary } from '../types/threatDetectionReport';
import type { IdentityAccessSummary } from '../types/identityAccessReport';
// Namespace import, not a named one: the arm below must be observable by a
// `vi.spyOn(threat, 'renderThreatDetectionReport')` in
// reportPdf.threatDetection.test.ts. A type with no arm falls silently through
// to renderGenericReport, and that spy is the only thing that catches it.
import * as threatDetectionPdf from './threatDetectionPdf';
import type { EndpointManagementSummary } from '../types/endpointManagementReport';
import { renderEndpointManagementReport } from './endpointManagementPdf';
import type { VulnerabilityManagementSummary } from '../types/vulnerabilityManagementReport';
import { renderVulnerabilityManagementReport } from './vulnerabilityManagementPdf';
import * as identityAccessPdf from './identityAccessPdf';
// Namespace imports for the three business report types (#3198 W02), same
// no-cycle / spy-visibility reason as threatDetectionPdf/identityAccessPdf.
import * as ticketSlaPdf from './ticketSlaPdf';
import * as ticketSlaPerformancePdf from './ticketSlaPerformancePdf';
import * as technicianTimePdf from './technicianTimePdf';
import * as arAgingPdf from './arAgingPdf';
import * as aiUsageByClientPdf from './aiUsageByClientPdf';
import * as mrrRenewalsPdf from './mrrRenewalsPdf';
import * as quoteWinRatePdf from './quoteWinRatePdf';
import * as clientProfitabilityPdf from './clientProfitabilityPdf';
import type { TicketSlaSummary, TechnicianTimeSummary, ArAgingSummary, AiUsageByClientSummary, MrrRenewalsSummary, QuoteWinRateSummary, ClientProfitabilitySummary } from '../types/businessReports';
import { isTicketSlaPerformanceSummary, type TicketSlaPerformanceSummary } from '../types/ticketSlaPerformance';
import {
  NARRATIVE_BULLET_MAX_CHARS,
  NARRATIVE_HEADLINE_MAX_CHARS,
  NARRATIVE_SECTION_KEYS,
  NARRATIVE_SECTION_TITLES,
  type OrgNarrativeReportSummary,
} from '../types/orgNarrativeReport';
import {
  FLEET_DESIGN_SECTION_KEYS,
  FLEET_DESIGN_SECTION_TITLES,
  FLEET_DESIGN_TEXT_MAX_CHARS,
  type FleetDesignReportSummary,
} from '../types/fleetDesign';
import {
  REPORT_META_SEPARATOR,
  formatReportDate,
  formatReportDateTime,
  formatReportPeriod,
  formatReportPeriodDay,
  REPORT_PERIOD_ZONE_LABEL,
  reportPageGeometry,
  resolveReportLocale,
  type ReportDateFormat,
  type ReportLocale,
  type ReportPageGeometry,
  type ReportPageSize,
  type ReportTimeFormat,
} from './reportLocale';

/**
 * Branded PDF design system for Breeze reports.
 *
 * One visual language for every exported report: a partner-branded header band
 * (partner logo when uploaded, Breeze wordmark otherwise), a running footer with
 * page numbers and a confidentiality marker, a posture scorecard cover for the
 * security & compliance report, and a humanized, colour-coded data table.
 *
 * Pure rendering only — no network, no DOM, no path-alias deps — so it can be
 * exercised headlessly. `reportExport.ts` owns the public API, branding fetch,
 * timezone handling, and CSV/Excel paths, and delegates PDF building here.
 */

type RGB = [number, number, number];

// Palette derived from the web theme tokens (apps/web/src/styles/globals.css),
// converted from HSL to the sRGB tuples jsPDF expects.
const BASE_C = {
  ink: [17, 19, 24] as RGB, //            foreground
  primary: [47, 85, 198] as RGB, //       --primary  hsl(225 62% 48%)
  primaryDeep: [33, 58, 138] as RGB, //   header band shade
  teal: [14, 212, 197] as RGB, //         brand accent (logo strokes)
  success: [42, 147, 98] as RGB, //       --success  hsl(152 56% 37%)
  danger: [221, 70, 60] as RGB, //        --destructive hsl(4 76% 56%)
  warning: [160, 102, 8] as RGB, //       --warning, darkened to ≥4.5:1 on white (AA at table sizes)
  muted: [92, 99, 112] as RGB, //         secondary text — darkened to ≥4.5:1 on white (AA)
  faint: [108, 115, 128] as RGB, //       de-emphasized but still AA-legible (N/A, ticks, footer ~4.8:1)
  rule: [223, 227, 233] as RGB, //        --border (decorative lines / meter track only — never text)
  zebra: [247, 248, 251] as RGB, //       table stripe
  panel: [244, 246, 252] as RGB, //       scorecard / panel fill
  white: [255, 255, 255] as RGB,
  bandText: [224, 231, 250] as RGB, //    secondary text on the band
} satisfies Record<string, RGB>;

type Palette = { [K in keyof typeof BASE_C]: RGB };

/**
 * The active palette. `buildReportPdf` swaps in the partner's brand colours
 * for the duration of one synchronous build and restores the Breeze default
 * afterwards, so every drawing helper keeps reading `C.primary` unchanged.
 */
let C: Palette = BASE_C;

// --- Brand colour derivation --------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHexColor(value: string | null | undefined): RGB | null {
  const v = (value ?? '').trim();
  if (!HEX_COLOR.test(v)) return null;
  const h = v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function relativeLuminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;
}

/** Darken until the colour reads as text on white and carries white text on a band (≥4.5:1). */
function ensureTextContrast(color: RGB): RGB {
  let c = color;
  for (let i = 0; i < 20 && contrastRatio(c, BASE_C.white) < 4.5; i += 1) c = mix(c, BASE_C.ink, 0.12);
  return c;
}

/**
 * Partner brand colours applied to the report chrome. The primary carries the
 * band, subtitle, table heads and bullets; the accent carries the ribbon and
 * section ticks. Status colours (green/amber/red) never change — they mean
 * something. A brand primary too light for white text is darkened, not
 * rejected, so the deliverable stays recognisably the partner's.
 */
export function paletteForBranding(branding?: ReportBranding | null): Palette {
  const primary = parseHexColor(branding?.primaryColor);
  if (!primary) return BASE_C;
  const safePrimary = ensureTextContrast(primary);
  const accent = parseHexColor(branding?.accentColor) ?? mix(primary, BASE_C.white, 0.45);
  return {
    ...BASE_C,
    primary: safePrimary,
    primaryDeep: mix(safePrimary, BASE_C.ink, 0.3),
    teal: accent,
    bandText: mix(safePrimary, BASE_C.white, 0.85),
  };
}

export type ReportBranding = {
  /** Partner display name; falls back to "Breeze" when null. */
  name: string | null;
  /** Partner logo as a raster data URL (PNG/JPEG). Null → vector Breeze mark. */
  logoDataUrl: string | null;
  /** Logo intrinsic aspect ratio (width / height); used to size without distortion. */
  logoAspect: number | null;
  /** Partner brand primary as a hex string; null keeps the Breeze palette. */
  primaryColor?: string | null;
  /** Partner brand accent (ribbon, section ticks); derived from the primary when null. */
  accentColor?: string | null;
  /** Partner contact for the closing "to approve or discuss" line; null hides it. */
  contactEmail?: string | null;
  contactName?: string | null;
  /** The partner's document page size (`partners.document_page_size`, the
   *  one its quotes and invoices print on). Absent → A4 (#12048). */
  pageSize?: ReportPageSize | null;
  /** The partner's date order and hour cycle (`partners.settings.dateFormat`
   *  / `timeFormat`). Absent → "Nov 9, 2026" and a 12-hour clock. */
  dateFormat?: ReportDateFormat | null;
  timeFormat?: ReportTimeFormat | null;
};

export type BuildOpts = {
  reportType: string;
  /** Generation instant. Pass a Date (or ISO string with a time) and the
   *  renderer prints it in the partner's format with its timezone (#12048); any
   *  other string is printed as given (callers that pre-format). */
  generatedAt: string | Date;
  /** IANA timezone for formatting ISO date cells in generic tables. */
  timezone: string;
  summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary | HardwareLifecycleSummary | ThreatDetectionSummary | EndpointManagementSummary | VulnerabilityManagementSummary | IdentityAccessSummary
    | TicketSlaSummary | TechnicianTimeSummary | ArAgingSummary | AiUsageByClientSummary | MrrRenewalsSummary | QuoteWinRateSummary | ClientProfitabilitySummary | TicketSlaPerformanceSummary | BackupStatusReportData;
  /** Slim baseline from the previous completed run, when the caller supplied
   * one (report_runs.result.previous) — drives the scorecard trend chip and
   * its "since <date>" label. */
  previous?: { generatedAt?: string | null; summary?: unknown };
  branding?: ReportBranding;
  /** Called when a type with a designed renderer falls through to the generic
   *  row table (its summary is missing or the wrong shape) — the designed
   *  body, notes included, is lost. The shared package cannot reach error
   *  tracking, so server callers pass `captureException` through here. */
  onRendererFallback?: (info: { reportType: string; reason: 'summary_missing' | 'summary_shape_mismatch' }) => void;
};

/** BuildOpts after `buildReportPdf` has resolved the generated time to its printed form. */
type RenderOpts = Omit<BuildOpts, 'generatedAt'> & { generatedAt: string };

/** Types whose PDF is a designed renderer that must never degrade silently
 *  (#3198 W02 fix round). */
const DESIGNED_BUSINESS_TYPES: ReadonlySet<string> = new Set([
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
  'ai_usage_by_client',
  'mrr_renewals',
  'quote_win_rate',
  'client_profitability',
  'ticket_sla_performance',
]);

/**
 * The active page geometry and locale. `buildReportPdf` swaps in the partner's
 * page size and date conventions for one synchronous build and restores the
 * defaults afterwards — the same pattern as the palette `C` — so every drawing
 * helper keeps reading `PAGE.w` unchanged (#12048).
 */
const DEFAULT_PAGE = reportPageGeometry('a4');
let PAGE: ReportPageGeometry = DEFAULT_PAGE;
const DEFAULT_LOCALE = resolveReportLocale(undefined, 'UTC');
let L: ReportLocale = DEFAULT_LOCALE;

/** A date in the report's locale, or `fallback` when there is none. */
const fmtDate = (value: string | Date | null | undefined, fallback = '—'): string => formatReportDate(value, L) ?? fallback;
const fmtDateTime = (value: string | Date | null | undefined, fallback = '—'): string => formatReportDateTime(value, L) ?? fallback;
const TOTAL_TOKEN = '{tpc}'; // jsPDF total-page-count placeholder

const set = {
  fill: (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2]),
  draw: (doc: jsPDF, c: RGB) => doc.setDrawColor(c[0], c[1], c[2]),
  text: (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]),
};

const titleCase = (s: string): string =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

// Display names for report types whose titleCase form loses punctuation
// (the band label must match the page-1 H1, ampersand included).
const REPORT_TYPE_LABELS: Record<string, string> = {
  security_compliance_posture: 'Security & Compliance Posture',
  ai_org_narrative: 'Weekly AI Operations Narrative',
  ai_agent_impact: 'AI Agent Impact',
  ai_fleet_design: 'Fleet Design',
  identity_access_review: 'Identity & Access Review',
  hardware_lifecycle: 'Hardware Lifecycle',
  backup_status: 'Backup Status',
  threat_detection_review: 'Threat Detection Review',
  endpoint_management_review: 'Endpoint Management Review',
  vulnerability_management: 'Vulnerability Management',
  ticket_sla_attainment: 'Ticket SLA Attainment',
  technician_time_billability: 'Technician Time & Billability',
  ar_aging: 'AR Aging',
  ai_usage_by_client: 'AI Usage by Client',
  mrr_renewals: 'MRR & Renewals',
  quote_win_rate: 'Quote Win Rate',
  client_profitability: 'Client Profitability',
  ticket_sla_performance: 'Service Level Performance',
};

const reportTypeLabel = (t: string): string => REPORT_TYPE_LABELS[t] ?? titleCase(t);

// Domain acronyms that should stay upper-cased in humanized column headers.
const ACRONYMS = new Set([
  'os', 'cpu', 'ram', 'gb', 'mb', 'tb', 'id', 'ip', 'url', 'av', 'dns',
  'mfa', 'cis', 'edr', 'mdr', 'uac', 'pam', 'rmm', 'sla', 'rtp', 'vuln',
]);

// camelCase / snake_case → "Title Case", keeping known acronyms upper-cased.
function humanizeHeader(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => {
      const lw = w.toLowerCase();
      if (lw === 'pct') return '%';
      if (ACRONYMS.has(lw)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// ----------------------------------------------------------------------------
// Brand chrome: header band + footer, drawn on every page via didDrawPage.
// ----------------------------------------------------------------------------

// The Breeze wind mark — three gust strokes with curled tails, transcribed from
// the product logo (apps/web/public/favicon.svg, 32-unit art space). Each path
// is a start point plus relative cubic-bezier segments for jsPDF `lines()`.
type MarkPath = { start: [number, number]; curves: [number, number, number, number, number, number][] };
const BREEZE_MARK_PATHS: MarkPath[] = [
  { start: [6, 11], curves: [[0, 0, 4, 0, 8, 0], [4, 0, 6, -3, 10, -3], [2, 0, 3, 1, 3, 2], [0, 1, -1, 2, -3, 2], [-2, 0, -3, -1, -3, -1]] },
  { start: [4, 17], curves: [[0, 0, 5, 0, 11, 0], [6, 0, 8, -3, 11, -3], [1.5, 0, 2.5, 1, 2.5, 2], [0, 1, -1, 2, -2.5, 2], [-2, 0, -3, -1, -3, -1]] },
  { start: [7, 23], curves: [[0, 0, 4, 0, 9, 0], [4, 0, 6, -3, 9, -3], [1.5, 0, 2.5, 1, 2.5, 2], [0, 1, -1, 2, -2.5, 2], [-2, 0, -3, -1, -3, -1]] },
];

/** The Breeze logo as it appears in the product: dark rounded chip + teal gusts. */
function drawBreezeMark(doc: jsPDF, x: number, yMid: number, size = 9): void {
  const s = size / 32; // favicon art space is 32 units square
  set.fill(doc, C.ink);
  doc.roundedRect(x, yMid - size / 2, size, size, 8 * s, 8 * s, 'F');
  set.draw(doc, C.teal);
  doc.setLineCap('round');
  doc.setLineJoin('round');
  doc.setLineWidth(2 * s);
  const y0 = yMid - size / 2;
  for (const p of BREEZE_MARK_PATHS) {
    doc.lines(p.curves, x + p.start[0] * s, y0 + p.start[1] * s, [s, s], 'S', false);
  }
}

/**
 * Pages whose header band / footer are already drawn. Several renderers draw
 * the chrome for page 1 themselves and autotable's `didDrawPage` draws it again
 * for the same page, which embedded the partner logo two or three times on a
 * one-page report (#12041). Chrome is drawn once per page, whoever asks first.
 */
const chromeDrawn = new WeakMap<jsPDF, { header: Set<number>; footer: Set<number> }>();

function claimChrome(doc: jsPDF, part: 'header' | 'footer'): boolean {
  let drawn = chromeDrawn.get(doc);
  if (!drawn) {
    drawn = { header: new Set(), footer: new Set() };
    chromeDrawn.set(doc, drawn);
  }
  const page = doc.getCurrentPageInfo().pageNumber;
  if (drawn[part].has(page)) return false;
  drawn[part].add(page);
  return true;
}

/** Warn about a logo that will not embed once per document, not once per page. */
const logoWarned = new WeakSet<jsPDF>();
function claimLogoWarning(doc: jsPDF): boolean {
  if (logoWarned.has(doc)) return false;
  logoWarned.add(doc);
  return true;
}

/** Height of the brand-colour rule closing the letterhead band. */
const LETTERHEAD_RULE_H = 1.2;

/** The brand-colour band: partner name (or the Breeze mark) in white. */
function paintBrandBand(doc: jsPDF): void {
  set.fill(doc, C.primary);
  doc.rect(0, 0, PAGE.w, PAGE.bandH, 'F');
  set.fill(doc, C.teal);
  doc.rect(0, PAGE.bandH, PAGE.w, 0.7, 'F');
}

/**
 * The letterhead band for a partner logo: white, closed by a brand-colour rule
 * and the accent ribbon. The logo sits directly on white, as it does on the
 * partner's own letterhead — no white chip pasted onto a dark band (#12041).
 */
function paintLetterheadBand(doc: jsPDF): void {
  set.fill(doc, C.white);
  doc.rect(0, 0, PAGE.w, PAGE.bandH, 'F');
  set.fill(doc, C.primary);
  doc.rect(0, PAGE.bandH - LETTERHEAD_RULE_H, PAGE.w, LETTERHEAD_RULE_H, 'F');
  set.fill(doc, C.teal);
  doc.rect(0, PAGE.bandH, PAGE.w, 0.7, 'F');
}

function drawHeaderBand(doc: jsPDF, opts: RenderOpts): void {
  if (!claimChrome(doc, 'header')) return;
  const { branding, reportType } = opts;
  const name = branding?.name?.trim() || 'Breeze';
  const bandMid = PAGE.bandH / 2;
  // Centre of the white area above the letterhead's closing rule.
  const letterheadMid = (PAGE.bandH - LETTERHEAD_RULE_H) / 2;

  // Partner logo when uploaded (carries its own wordmark); otherwise the Breeze
  // vector mark + partner/Breeze name. A failed embed degrades to the partner
  // name on the brand band (or the Breeze mark and name with no partner).
  let drewLogo = false;
  if (branding?.logoDataUrl) {
    paintLetterheadBand(doc);
    // Fit the logo inside an 11 mm × 64 mm box, preserving its aspect: a tall
    // mark fills the height, a wide wordmark fills the width and shrinks.
    const maxH = 11;
    const maxW = 64;
    const aspect = branding.logoAspect && branding.logoAspect > 0 ? branding.logoAspect : 3;
    const logoH = Math.min(maxH, maxW / aspect);
    const logoW = logoH * aspect;
    try {
      doc.addImage(branding.logoDataUrl, 'PNG', PAGE.mx, letterheadMid - logoH / 2, logoW, logoH, undefined, 'FAST');
      drewLogo = true;
    } catch (err) {
      // Visible on the page (name instead of logo); logged so a corrupt or
      // non-PNG stored logo is findable rather than a silent downgrade.
      if (claimLogoWarning(doc)) console.warn('[reportPdf] Partner logo could not be embedded; using the name header', err);
      drewLogo = false;
    }
  }
  if (!drewLogo) {
    // Also paints over the white letterhead when the logo would not embed.
    paintBrandBand(doc);
    // Partner-branded but no usable logo: the partner's name IS the letterhead —
    // pairing it with the Breeze mark would brand the deliverable with the
    // tooling instead of the MSP. The Breeze mark appears only when there is no
    // partner context at all.
    const isPartnerBranded = Boolean(branding?.name?.trim());
    let textX = PAGE.mx;
    if (!isPartnerBranded) {
      drawBreezeMark(doc, PAGE.mx, bandMid);
      textX = PAGE.mx + 12;
    }
    set.text(doc, C.white);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(name, textX, bandMid + 0.2, { baseline: 'middle' });
  }

  // Right side: document category label — brand colour on the white
  // letterhead, the light band tint on the brand band.
  set.text(doc, drewLogo ? C.primary : C.bandText);
  doc.setFont('helvetica', drewLogo ? 'bold' : 'normal');
  doc.setFontSize(8.5);
  doc.text(reportTypeLabel(reportType).toUpperCase(), PAGE.w - PAGE.mx, (drewLogo ? letterheadMid : bandMid) + 1, {
    align: 'right',
    baseline: 'middle',
  });
}

function drawFooter(doc: jsPDF, opts: RenderOpts): void {
  if (!claimChrome(doc, 'footer')) return;
  set.draw(doc, C.rule);
  doc.setLineWidth(0.2);
  doc.line(PAGE.mx, PAGE.footY, PAGE.w - PAGE.mx, PAGE.footY);
  set.text(doc, C.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  const y = PAGE.footY + 4.5;
  // Absolute page number (autotable's data.pageNumber is table-relative and
  // wrong once a cover page precedes the table).
  const pageNumber = doc.getCurrentPageInfo().pageNumber;
  // White-label attribution: this is the partner's deliverable, so their name
  // signs it. Breeze appears only when there is no partner context.
  const partnerName = opts.branding?.name?.trim();
  doc.text(partnerName ? `Prepared by ${partnerName}` : 'Generated by Breeze RMM', PAGE.mx, y);
  doc.text('Confidential', PAGE.w / 2, y, { align: 'center' });
  doc.text(`Page ${pageNumber} of ${TOTAL_TOKEN}`, PAGE.w - PAGE.mx, y, { align: 'right' });
}

// ----------------------------------------------------------------------------
// Page-1 content: title block, posture scorecard, control-coverage grid.
// ----------------------------------------------------------------------------

function drawTitleBlock(doc: jsPDF, title: string, subtitle: string, meta: string, top: number): number {
  let y = top;
  set.text(doc, C.ink);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text(title, PAGE.mx, y);
  if (subtitle) {
    y += 6.5;
    set.text(doc, C.primary);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(subtitle, PAGE.mx, y);
  }
  y += 5.5;
  set.text(doc, C.muted);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(meta, PAGE.mx, y);
  return y + 4;
}

type ScoreBand = { label: string; color: RGB };

// Both passing bands use the status green: the brand primary is not a status
// colour, and a dark-blue "GOOD" chip read as a fifth status (#12044).
function scoreBand(score: number): ScoreBand {
  if (score >= 80) return { label: 'STRONG', color: C.success };
  if (score >= 60) return { label: 'GOOD', color: C.success };
  if (score >= 40) return { label: 'FAIR', color: C.warning };
  return { label: 'AT RISK', color: C.danger };
}

/** One-line meaning of the posture bands, printed under the scorecard. */
const POSTURE_BAND_KEY =
  'Bands: Strong 80+, Good 60\u201379, Fair 40\u201359, At risk under 40; capped at Fair while critical patches or vulnerabilities are open or a device is unprotected.';

/**
 * The posture cover's band. The score averages per-device factors, so a fleet
 * can score in the passing range while carrying many critical vulnerabilities;
 * a passing band beside open criticals or an unprotected device contradicts the
 * page, so the band is capped at FAIR until they are cleared. It never raises a
 * lower band.
 * Exported for tests.
 */
export function postureScoreBand(
  score: number,
  risk: { criticalFindings: number; unprotected: number },
): ScoreBand {
  const band = scoreBand(score);
  const passing = band.label === 'STRONG' || band.label === 'GOOD';
  if (passing && (risk.criticalFindings > 0 || risk.unprotected > 0)) {
    return { label: 'FAIR', color: C.warning };
  }
  return band;
}

type ScoreStat = { label: string; value: string; tone: RGB };

/**
 * Horizontal layout of the scorecard panel for a content box starting at `x`,
 * `w` wide. The right rail is anchored to the right edge, so on the 17.6 mm
 * narrower Letter page the meter shrinks to stop 4 mm short of the rail's
 * divider instead of running under it (#12048); on A4 it keeps its designed
 * 88 mm. Exported for tests.
 */
export function scorecardLayout(x: number, w: number, hasStats: boolean): { meterX: number; meterW: number; captionW: number; railX: number } {
  const meterX = x + 74;
  const railX = x + w - 92;
  const limit = hasStats ? railX - 7 - 4 : x + w - 6;
  return { meterX, meterW: Math.min(88, limit - meterX), captionW: limit - meterX, railX };
}

function drawScorecard(
  doc: jsPDF,
  score: number,
  caption: string,
  stats: ScoreStat[],
  top: number,
  trend?: { delta: number; sinceLabel: string } | null,
  bandOverride?: ScoreBand,
): number {
  const x = PAGE.mx;
  const w = PAGE.w - PAGE.mx * 2; // full content width — no dead right half
  const h = 32;
  const band = bandOverride ?? scoreBand(score);

  set.fill(doc, C.panel);
  doc.roundedRect(x, top, w, h, 2.5, 2.5, 'F');

  // Big score numeral + /100.
  set.text(doc, band.color);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(34);
  const scoreStr = String(score);
  doc.text(scoreStr, x + 10, top + 21);
  const scoreW = doc.getTextWidth(scoreStr);
  set.text(doc, C.muted);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.text('/100', x + 10 + scoreW + 1.5, top + 21);

  // Band chip.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  const chipLabel = band.label;
  const chipW = doc.getTextWidth(chipLabel) + 7;
  set.fill(doc, band.color);
  doc.roundedRect(x + 10, top + 24.5, chipW, 4.8, 2.4, 2.4, 'F');
  set.text(doc, C.white);
  doc.text(chipLabel, x + 10 + chipW / 2, top + 27.8, { align: 'center' });

  // Trend vs the previous run: "+5 since Jun 1" — the line that makes a
  // recurring report feel alive. Muted date; signed delta carries the colour.
  // Plain +/- text, not a ▲/▼ glyph: jsPDF's built-in helvetica doesn't carry
  // those glyphs, so they rendered as garbage with a miscalculated width that
  // overlapped the "since" label (visually confirmed via the PNG harness).
  if (trend && trend.delta !== 0) {
    const up = trend.delta > 0;
    set.text(doc, up ? C.success : C.danger);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const deltaStr = `${up ? '+' : ''}${trend.delta}`;
    const chipRight = x + 10 + chipW;
    doc.text(deltaStr, chipRight + 4, top + 27.8);
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(trend.sinceLabel, chipRight + 4 + doc.getTextWidth(deltaStr) + 2, top + 27.8);
  }

  // Meter: caption above, track + filled portion, 0/50/100 ticks below.
  const { meterX, meterW, captionW, railX } = scorecardLayout(x, w, stats.length > 0);
  const meterY = top + 15;
  if (caption) {
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    // On the narrower Letter page a long caption wraps to two lines rather
    // than running into the right rail.
    const lines = (doc.splitTextToSize(caption, captionW) as string[]).slice(0, 2);
    if (lines.length > 1) {
      doc.text(lines[0]!, meterX, top + 6.2);
      doc.text(lines[1]!, meterX, top + 9.6);
    } else {
      doc.text(caption, meterX, top + 9);
    }
  }
  set.fill(doc, C.rule);
  doc.roundedRect(meterX, meterY, meterW, 3, 1.5, 1.5, 'F');
  const pct = Math.max(0, Math.min(100, score)) / 100;
  if (pct > 0) {
    set.fill(doc, band.color);
    doc.roundedRect(meterX, meterY, Math.max(meterW * pct, 3), 3, 1.5, 1.5, 'F');
  }
  set.text(doc, C.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text('0', meterX, meterY + 8);
  doc.text('50', meterX + meterW / 2, meterY + 8, { align: 'center' });
  doc.text('100', meterX + meterW, meterY + 8, { align: 'right' });

  // Right rail: 2-3 risk stats that drive the score.
  if (stats.length > 0) {
    set.draw(doc, C.rule);
    doc.setLineWidth(0.25);
    doc.line(railX - 7, top + 5, railX - 7, top + h - 5);
    const cellW = 90 / stats.length;
    stats.forEach((st, i) => {
      const cx = railX + cellW * i + cellW / 2;
      set.text(doc, st.tone);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text(st.value, cx, top + 16, { align: 'center' });
      set.text(doc, C.muted);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      // A long label (e.g. "AV protected · 1 not assessed") wraps inside its
      // cell instead of running into the neighbouring stat; at most two lines
      // fit above the panel edge, so labels are kept short enough for that.
      // Prefer breaking at the " · " qualifier over mid-phrase.
      const labelLines = doc.getTextWidth(st.label) <= cellW - 3
        ? [st.label]
        : st.label.split(' · ').flatMap((part) => doc.splitTextToSize(part, cellW - 3) as string[]);
      labelLines.slice(0, 2).forEach((line, li) => {
        doc.text(line, cx, top + 23 + li * 3.2, { align: 'center' });
      });
      if (i > 0) {
        set.draw(doc, C.rule);
        doc.setLineWidth(0.15);
        doc.line(railX + cellW * i, top + 8, railX + cellW * i, top + h - 8);
      }
    });
  }

  return top + h + 6;
}

/** Delta + "since <date>" label for the scorecard trend chip, derived from
 * `opts.previous` — the slim baseline copied onto the run snapshot at
 * generation time. Returns null when there's nothing to compare (no prior
 * run, or the prior summary didn't capture this metric). */
function trendFor(opts: RenderOpts, current: number | null | undefined, pick: (s: Record<string, unknown>) => unknown): { delta: number; sinceLabel: string } | null {
  const prevSummary = opts.previous?.summary;
  if (current == null || !prevSummary || typeof prevSummary !== 'object') return null;
  const prevRaw = pick(prevSummary as Record<string, unknown>);
  const prev = typeof prevRaw === 'number' ? prevRaw : null;
  if (prev == null) return null;
  let since = 'vs previous run';
  const iso = opts.previous?.generatedAt;
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      since = `since ${new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, month: 'short', day: 'numeric' }).format(d)}`;
    }
  }
  return { delta: current - prev, sinceLabel: since };
}

function drawSectionHeading(doc: jsPDF, text: string, y: number): number {
  set.fill(doc, C.teal);
  doc.rect(PAGE.mx, y - 3.4, 1.7, 4.4, 'F');
  set.text(doc, C.ink);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(text, PAGE.mx + 4, y);
  return y + 5;
}

type MetricStatus = 'good' | 'bad' | 'warn' | 'neutral' | 'na';

const STATUS_COLOR: Record<MetricStatus, RGB> = {
  good: C.success,
  bad: C.danger,
  warn: C.warning,
  neutral: C.ink,
  na: C.faint,
};

type Metric = { label: string; value: string; status: MetricStatus; target?: string };

/**
 * Two-column metric grid: dot + label … coloured value + muted target hint.
 * Fills column-major (top-to-bottom, then the right column) so the caller's
 * array order reads as two thematic clusters instead of interleaving them.
 */
function drawMetricGrid(doc: jsPDF, metrics: Metric[], top: number): number {
  const colW = (PAGE.w - PAGE.mx * 2 - 8) / 2;
  const rowH = 6.0;
  const rows = Math.ceil(metrics.length / 2);
  metrics.forEach((m, i) => {
    // Padding slots (empty label, used to keep a shorter column aligned with a
    // taller one under column-major fill) draw nothing — no stray dot/hairline.
    if (!m.label) return;
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = PAGE.mx + col * (colW + 8);
    const y = top + row * rowH;
    // Status dot; informational metrics (no pass/fail judgement) get a hollow
    // ring so they don't masquerade as a fifth status colour.
    if (m.status === 'neutral') {
      set.draw(doc, C.muted);
      doc.setLineWidth(0.35);
      doc.circle(x + 1.4, y - 1.2, 1, 'S');
    } else {
      set.fill(doc, STATUS_COLOR[m.status]);
      doc.circle(x + 1.4, y - 1.2, 1.2, 'F');
    }
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(m.label, x + 5, y);
    // Target hint (e.g. "≥90%") sits right-aligned at the column edge; the
    // coloured value sits just left of it so the reader sees value-vs-target.
    let valueRight = x + colW;
    if (m.target) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      set.text(doc, C.faint);
      doc.text(m.target, x + colW, y, { align: 'right' });
      valueRight = x + colW - doc.getTextWidth(m.target) - 3;
    }
    set.text(doc, STATUS_COLOR[m.status]);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(m.value, valueRight, y, { align: 'right' });
    // hairline separator
    set.draw(doc, C.rule);
    doc.setLineWidth(0.1);
    doc.line(x, y + 2.1, x + colW, y + 2.1);
  });
  return top + rows * rowH + 3;
}

/** One-line color key, right-aligned to a section heading row. */
function drawLegend(doc: jsPDF, y: number): void {
  const items: [RGB | null, string][] = [
    [C.success, 'Meets target'],
    [C.warning, 'Needs attention'],
    [C.danger, 'At risk'],
    [C.faint, 'Not assessed'],
    [null, 'Not scored'], // hollow ring — matches neutral metric dots
  ];
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  const dotGap = 2.4;
  const itemGap = 6;
  const widths = items.map(([, t]) => 2 + dotGap + doc.getTextWidth(t));
  const total = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
  let x = PAGE.w - PAGE.mx - total;
  items.forEach(([color, label], i) => {
    if (color) {
      set.fill(doc, color);
      doc.circle(x + 1, y - 1.1, 1.1, 'F');
    } else {
      set.draw(doc, C.muted);
      doc.setLineWidth(0.3);
      doc.circle(x + 1, y - 1.1, 0.9, 'S');
    }
    set.text(doc, C.muted);
    doc.text(label, x + 2 + dotGap, y);
    x += (widths[i] ?? 0) + itemGap;
  });
}

// ----------------------------------------------------------------------------
// Posture cover (summary scorecard + control coverage + PAM + products).
// ----------------------------------------------------------------------------

const yesNo = (v: boolean | undefined): string => (v ? 'Yes' : 'No');
const boolStatus = (v: boolean | undefined): MetricStatus => (v === undefined ? 'na' : v ? 'good' : 'bad');
const pctStr = (v: number | null | undefined): string => (v == null ? 'N/A' : `${v}%`);
/** A control % is over ASSESSED devices; disclose the in-scope devices it leaves out. */
const withNotAssessed = (value: string, unknown: number | undefined): string =>
  unknown != null && unknown > 0 ? `${value} \u00b7 ${unknown} not assessed` : value;
function pctStatus(v: number | null | undefined, good = 90, warn = 60): MetricStatus {
  if (v == null) return 'na';
  if (v >= good) return 'good';
  if (v >= warn) return 'warn';
  return 'bad';
}

/**
 * The cover's Backup metric. Given the product inventory, it names every
 * backup product (first-party config, SaaS backup, third-party providers such
 * as Cove — #6012) and grades by how many are working; without one it keeps
 * the legacy Yes/No. A site-restricted report withholds org-wide backup
 * evidence (`backupConfigured` absent), and a partial product list must not
 * stand in for it there, so that case stays legacy too.
 */
export function buildPostureBackupMetric(controls: PostureControls, products: PostureProduct[] = []) {
  const backupRequired = controls.backupRequired !== false;
  const backupProducts = products.filter((product) => product.category === 'backup');
  if (backupProducts.length > 0 && controls.backupConfigured !== undefined) {
    // A product counts as working only when it is active AND backs up every
    // device it covers: "1 of 200 devices backed up" must not grade green on
    // the cover (the per-device shortfall is otherwise only in the inventory).
    const activeCount = backupProducts.filter((product) =>
      product.active !== false &&
      (product.deviceCoverage == null ||
        product.activeDeviceCoverage == null ||
        product.activeDeviceCoverage >= product.deviceCoverage),
    ).length;
    const anyActive = backupProducts.some((product) => product.active !== false);
    return {
      label: 'Backup',
      value: backupProducts.map((product) => product.product).join(', '),
      status: !backupRequired
        ? 'neutral'
        : activeCount === backupProducts.length
          ? 'good'
          : anyActive
            ? 'warn'
            : 'bad',
    } satisfies Metric;
  }
  const backupValue = backupRequired
    ? `${yesNo(controls.backupConfigured)}${controls.backupConfigured && controls.backupEncrypted ? ' (encrypted)' : ''}`
    : controls.backupConfigured
      ? 'Optional; configured'
      : 'Not in scope';
  return {
    label: 'Backup',
    value: backupValue,
    status: backupRequired ? boolStatus(controls.backupConfigured) : 'neutral',
  } satisfies Metric;
}

/**
 * Colour for a control whose % is over ASSESSED devices while `unknown` in-scope
 * devices were not assessed. One rule for every such row (#12044), replacing
 * the 20% share floor (Ruling 23), which painted 100%-with-1-unknown green,
 * 100%-with-2-unknown grey and 83%-against-a-10%-target grey on one page:
 *  - nothing assessed (value null)        → grey, "Not assessed";
 *  - a measured shortfall (warn / bad)    → keeps its colour, whatever the share;
 *  - a pass with any device not assessed  → amber, "Needs attention" — green is
 *    reserved for a control met across every in-scope device.
 * Stricter than Ruling 23: a pass never shows green beside unassessed devices.
 */
function coverageShareStatus(base: MetricStatus, unknown: number | undefined): MetricStatus {
  if (base !== 'good' || unknown == null || unknown <= 0) return base;
  return 'warn';
}

/** The posture cover's control-coverage grid, column-major (left: device
 *  protection & hygiene; right: access, identity & network). Pure; exported for tests. */
export function buildPostureCoverageMetrics(summary: PostureSummary): Metric[] {
  const c = summary.controls ?? {};
  const deviceCount = summary.deviceCount ?? 0;
  const pctRow = (
    label: string,
    pct: number | null | undefined,
    unknown: number | undefined,
    target: string,
    good = 90,
    warn = 60,
  ): Metric => ({
    label,
    value: withNotAssessed(pctStr(pct), unknown),
    status: coverageShareStatus(pctStatus(pct, good, warn), unknown),
    target,
  });
  const { unprotected, notAssessed: avUnknown } = postureProtectionCounts(summary);
  const protectionMetrics: Metric[] = [
    pctRow('EDR coverage', c.edrCoveragePct, c.edrUnknownCount, '90%+'),
    pctRow('AV + real-time protection', c.anyAvCoveragePct, c.anyAvUnknownCount, '95%+'),
    {
      label: 'Unprotected devices',
      // Devices with no protection evidence are not assessed, never counted
      // here as unprotected; say how many there are so 0 isn't read as all-clear.
      value: withNotAssessed(String(unprotected), avUnknown),
      status: unprotected > 0 ? 'bad' : avUnknown > 0 ? 'warn' : 'good',
      target: 'none', // "0" beside a value of 0 read as a duplicated numeral
    },
    { label: 'AV definitions current', value: pctStr(c.avDefinitionsCurrentPct), status: pctStatus(c.avDefinitionsCurrentPct), target: '95%+' },
    pctRow('Disk encryption', c.encryptionPct, c.encryptionUnknownCount, '90%+'),
    pctRow('Patch current (no critical pending)', c.patchCurrentPct, c.patchUnknownCount, '90%+', 90, 70),
  ];
  if (c.cisIncluded !== false) {
    const cisVal =
      c.cisAvgPassRate == null
        ? 'Not assessed'
        : `${c.cisAvgPassRate}% (${c.cisAssessedCount ?? 0}/${deviceCount})`;
    protectionMetrics.push({ label: 'CIS hardening', value: cisVal, status: pctStatus(c.cisAvgPassRate, 90, 70), target: '90%+' });
  }
  const backupMetric = buildPostureBackupMetric(c, summary.securityProducts ?? []);
  // Exposure is a "lower is better" %, so it is graded on its complement.
  const adminExposure = c.localAdminExposurePct;
  const accessMetrics: Metric[] = [
    pctRow('Host firewall', c.firewallPct, c.firewallUnknownCount, '95%+'),
    // Minimum length + account lockout (postureEvidence passwordComplexityResult),
    // not character-class complexity, so it is not labelled "complexity".
    pctRow('Password policy', c.passwordComplexityPct, c.passwordUnknownCount, '90%+'),
    {
      label: 'Local-admin exposure',
      value: withNotAssessed(pctStr(adminExposure), c.localAdminUnknownCount),
      status: coverageShareStatus(pctStatus(adminExposure == null ? null : 100 - adminExposure), c.localAdminUnknownCount),
      target: 'max 10%',
    },
    { label: 'Identity provider connected', value: yesNo(c.identityProviderConnected), status: boolStatus(c.identityProviderConnected) },
    backupMetric,
    { label: 'DNS filtering active', value: yesNo(c.dnsFilteringActive), status: boolStatus(c.dnsFilteringActive) },
  ];
  return [...protectionMetrics, ...accessMetrics];
}

type PostureAggregates = {
  criticalPatchCount: number;
  criticalVulnCount: number;
  /** Row-derived fallback for legacy snapshots without controls.unprotectedCount. */
  unprotectedCount: number;
};

/**
 * Protection figures the hero, grid and recommendations share, so they agree:
 * a device with no protection evidence is NOT ASSESSED, never unprotected
 * (#12044), and "protected" is counted over the assessed devices only.
 * A legacy snapshot (no `avAssessedCount`) folded unassessed devices into
 * `unprotectedCount`; it keeps its original figures (everything over the full
 * device count, nothing disclosed as not assessed) rather than subtracting the
 * unassessed devices twice. `legacyUnprotected` is the row-derived fallback
 * for snapshots that predate `unprotectedCount` itself.
 */
function postureProtectionCounts(summary: PostureSummary, legacyUnprotected = 0) {
  const c = summary.controls ?? {};
  const deviceCount = summary.deviceCount ?? 0;
  if (c.avAssessedCount == null) {
    const unprotected = c.unprotectedCount ?? legacyUnprotected;
    return { unprotected, notAssessed: 0, assessed: deviceCount, protectedCount: Math.max(0, deviceCount - unprotected) };
  }
  const assessed = Math.min(deviceCount, Math.max(0, c.avAssessedCount));
  const unprotected = Math.min(assessed, c.unprotectedCount ?? 0);
  return { unprotected, notAssessed: deviceCount - assessed, assessed, protectedCount: assessed - unprotected };
}

// Page 1 keeps clear of the acronym glossary pinned above the footer rule;
// continuation pages have no glossary.
const postureCoverBottom = (): number => PAGE.footY - 9;
const postureContinuedBottom = (): number => PAGE.footY - 5;
// Room the per-device table needs to start on a partly used page: section
// heading, the two-tier column header and a few device rows.
const POSTURE_TABLE_MIN_SPACE = 45;
const POSTURE_REC_ROW_HEIGHT = 5.2;

/**
 * Cursor for the posture content that follows the fixed cover sections
 * (recommendations, product inventory, device table). Content flows onto
 * continuation pages instead of being clipped or given a near-empty page of
 * its own (#12043). `chromePending` marks a page whose header band and footer
 * are not drawn yet.
 */
type PostureFlow = {
  doc: jsPDF;
  opts: RenderOpts;
  y: number;
  bottom: number;
  onCover: boolean;
  chromePending: boolean;
};

function finishPosturePage(flow: PostureFlow): void {
  if (!flow.chromePending) return;
  drawHeaderBand(flow.doc, flow.opts);
  drawFooter(flow.doc, flow.opts);
  flow.chromePending = false;
}

function newPostureContinuationPage(flow: PostureFlow): void {
  finishPosturePage(flow);
  flow.doc.addPage(L.pageSize, 'landscape');
  flow.y = drawTitleBlock(flow.doc, 'Security & Compliance Posture', '', 'Continued from the posture summary', PAGE.bandH + 8);
  flow.bottom = postureContinuedBottom();
  flow.onCover = false;
  flow.chromePending = true;
}

function renderPostureCover(
  doc: jsPDF,
  summary: PostureSummary,
  opts: RenderOpts,
  agg: PostureAggregates,
): PostureFlow {
  const p = summary.privilegedAccess ?? {};
  const deviceCount = summary.deviceCount ?? 0;
  const plural = (n: number) => (n === 1 ? '' : 's');

  // "in scope", not "assessed": many controls leave some of these devices
  // unassessed. A site filter can leave managed devices out; say how many, so
  // the count reconciles with the org's other reports (#12044).
  const excluded = summary.excludedBySiteFilterCount ?? 0;
  const meta =
    `Generated ${opts.generatedAt}   ·   ${deviceCount} device${plural(deviceCount)} in scope` +
    (excluded > 0 ? `   ·   ${excluded} managed device${plural(excluded)} at other sites not included` : '');
  let y = drawTitleBlock(doc, 'Security & Compliance Posture', summary.org?.name ?? '', meta, PAGE.bandH + 8);

  if (summary.postureScore != null) {
    // The meter must be captioned with what it plots (the composite score) —
    // captioning it with the AV-coverage % made the bar read as coverage.
    const caption = 'Overall posture score across assessed controls';
    const prot = postureProtectionCounts(summary, agg.unprotectedCount);
    // Critical patches and critical vulnerabilities are separate figures: one
    // combined tile read as contradicting the "no critical pending" patch row.
    const stats: ScoreStat[] = [
      {
        label: prot.notAssessed > 0 ? `AV protected · ${prot.notAssessed} not assessed` : 'AV protected',
        value: `${prot.protectedCount}/${prot.assessed}`,
        tone: prot.unprotected > 0 || prot.notAssessed > 0 ? C.warning : C.success,
      },
      { label: 'Critical patches', value: String(agg.criticalPatchCount), tone: agg.criticalPatchCount > 0 ? C.danger : C.success },
      { label: 'Critical vulnerabilities', value: String(agg.criticalVulnCount), tone: agg.criticalVulnCount > 0 ? C.danger : C.success },
    ];
    y = drawScorecard(
      doc,
      summary.postureScore,
      caption,
      stats,
      y,
      trendFor(opts, summary.postureScore, (s) => (s as { postureScore?: unknown }).postureScore),
      postureScoreBand(summary.postureScore, {
        criticalFindings: agg.criticalPatchCount + agg.criticalVulnCount,
        unprotected: prot.unprotected,
      }),
    );
    // Methodology and band meaning in muted lines, so "64 — FAIR" is auditable rather than oracular.
    set.text(doc, C.faint);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(
      'Score: weighted per-device security factors — patching 25%, encryption 15%, AV health 15%, firewall / open ports / password policy / OS currency 10% each, admin exposure 5% — averaged across assessed devices.',
      PAGE.mx,
      y - 2.5,
    );
    doc.text(POSTURE_BAND_KEY, PAGE.mx, y + 0.7);
    y += 4.7;
  }

  const ccHeadingY = y + 2;
  y = drawSectionHeading(doc, 'Control coverage', ccHeadingY);
  drawLegend(doc, ccHeadingY); // color key, right-aligned to the heading
  // Left column: device protection & hygiene. Right column: access, identity
  // & network. The grid fills column-major, so array order = reading order.
  y = drawMetricGrid(doc, buildPostureCoverageMetrics(summary), y);

  y = drawSectionHeading(doc, 'Privileged access (PAM)', y + 2.5);
  const pamMetrics: Metric[] = [
    { label: 'UAC interception', value: p.uacInterceptionEnabled ? 'Enabled' : 'Disabled', status: p.uacInterceptionEnabled ? 'good' : 'warn' },
    { label: 'Active PAM rules', value: String(p.activePamRules ?? 0), status: (p.activePamRules ?? 0) > 0 ? 'good' : 'neutral' },
    {
      // Legacy snapshots predate windowDays; fall back to the undated label.
      label: p.windowDays ? `Elevations (last ${p.windowDays} days)` : 'Elevations in window',
      value: `${p.elevationsInWindow ?? 0} (${p.elevationsApproved ?? 0} approved / ${p.elevationsDenied ?? 0} denied)`,
      status: 'neutral',
    },
    { label: 'MFA step-up enforced', value: yesNo(p.mfaStepUpEnforced), status: boolStatus(p.mfaStepUpEnforced) },
  ];
  y = drawMetricGrid(doc, pamMetrics, y);

  // Plain-language key for the acronyms a non-technical client will hit above,
  // pinned just over the footer rule of page 1.
  set.text(doc, C.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(
    'EDR: endpoint detection & response   ·   AV: antivirus   ·   MFA: multi-factor authentication   ·   UAC: Windows admin-consent prompting   ·   PAM: privileged access management   ·   CIS: Center for Internet Security benchmark',
    PAGE.mx,
    PAGE.footY - 2,
  );

  // Recommendations come before the product inventory: the reader's next step
  // matters more than the tooling list. Both flow onto a continuation page
  // rather than being truncated (#12043).
  const flow: PostureFlow = { doc, opts, y, bottom: postureCoverBottom(), onCover: true, chromePending: true };
  drawRecommendedActions(flow, buildRecommendations(summary, agg));
  drawPostureProducts(flow, summary.securityProducts ?? []);
  return flow;
}

// ----------------------------------------------------------------------------
// Recommended actions: plain-language next steps derived from failing controls.
// Bridges the gap between the score and the red rows beneath it — the reader
// leaves with a plan instead of a contradiction.
// ----------------------------------------------------------------------------

type Recommendation = { severity: 'bad' | 'warn'; text: string };

function buildRecommendations(summary: PostureSummary, agg: PostureAggregates): Recommendation[] {
  const c = summary.controls ?? {};
  const p = summary.privilegedAccess ?? {};
  const recs: Recommendation[] = [];
  const { unprotected, notAssessed } = postureProtectionCounts(summary, agg.unprotectedCount);
  if (unprotected === 1) {
    recs.push({ severity: 'bad', text: 'Deploy protection to the unprotected device — it is the fleet\'s most exposed endpoint.' });
  } else if (unprotected > 1) {
    recs.push({ severity: 'bad', text: `Deploy protection to the ${unprotected} unprotected devices — these are the fleet's most exposed endpoints.` });
  }
  const vulns = agg.criticalVulnCount;
  if (vulns > 0) {
    recs.push({ severity: 'bad', text: `Remediate ${vulns} critical vulnerabilit${vulns === 1 ? 'y' : 'ies'} (see per-device detail).` });
  }
  const patches = agg.criticalPatchCount;
  if (patches > 0) {
    recs.push({ severity: 'bad', text: `Install ${patches} pending critical patch${patches === 1 ? '' : 'es'} (see per-device detail).` });
  }
  if (c.backupRequired !== false && c.backupConfigured === false) {
    recs.push({ severity: 'bad', text: 'Configure backups — no backup solution is currently detected for this organization.' });
  }
  if (p.mfaStepUpEnforced === false) {
    recs.push({ severity: 'bad', text: 'Enforce MFA step-up so privileged actions require a second factor.' });
  }
  if (c.localAdminExposurePct != null && c.localAdminExposurePct > 10) {
    recs.push({ severity: 'bad', text: `Reduce local administrator rights — ${c.localAdminExposurePct}% of assessed devices have more administrators than allowed (target: 10% or fewer).` });
  }
  if (c.identityProviderConnected === false) {
    recs.push({ severity: 'warn', text: 'Connect an identity provider to centralize account and access control.' });
  }
  if (c.dnsFilteringActive === false) {
    recs.push({ severity: 'warn', text: 'Enable DNS filtering to block malicious domains before devices reach them.' });
  }
  if (c.encryptionPct != null && c.encryptionPct < 90) {
    recs.push({ severity: 'warn', text: `Encrypt remaining disks — ${c.encryptionPct}% of devices are encrypted against a 90% target.` });
  }
  if (c.edrCoveragePct != null && c.edrCoveragePct < 90) {
    recs.push({ severity: 'warn', text: `Extend EDR coverage (currently ${c.edrCoveragePct}%, target 90%).` });
  }
  if (c.patchCurrentPct != null && c.patchCurrentPct < 90) {
    recs.push({ severity: 'warn', text: `Bring pending patches current — ${c.patchCurrentPct}% of devices are patch-current against a 90% target.` });
  }
  if (c.avDefinitionsCurrentPct != null && c.avDefinitionsCurrentPct < 95) {
    recs.push({ severity: 'warn', text: 'Update stale antivirus definitions on lagging devices.' });
  }
  if (c.firewallPct != null && c.firewallPct < 95) {
    recs.push({ severity: 'warn', text: `Enable the host firewall on remaining devices (currently ${c.firewallPct}%).` });
  }
  if (c.passwordComplexityPct != null && c.passwordComplexityPct < 90) {
    recs.push({ severity: 'warn', text: `Set a minimum password length and account lockout on remaining devices (currently ${c.passwordComplexityPct}% meet the policy).` });
  }
  if (p.uacInterceptionEnabled === false) {
    recs.push({ severity: 'warn', text: 'Enable UAC interception so admin elevations are governed and auditable.' });
  }
  // A device with no protection evidence is not assessed, not a failure — but
  // it still needs a next step, or the gap stays invisible.
  if (notAssessed > 0) {
    recs.push({
      severity: 'warn',
      text: notAssessed === 1
        ? 'Restore security reporting on the device that has not reported protection status, so it can be assessed.'
        : `Restore security reporting on the ${notAssessed} devices that have not reported protection status, so they can be assessed.`,
    });
  }
  return [...recs.filter((r) => r.severity === 'bad'), ...recs.filter((r) => r.severity === 'warn')];
}

/**
 * Numbered, priority-ordered next steps. Every recommendation is drawn: what
 * does not fit on the current page continues on the next one, under a
 * "(continued)" heading — a heading never ends a page on its own.
 */
function drawRecommendedActions(flow: PostureFlow, recs: Recommendation[]): void {
  if (recs.length === 0) return;
  const { doc } = flow;
  const headingSpace = 2.5 + 5;
  if (flow.y + headingSpace + POSTURE_REC_ROW_HEIGHT > flow.bottom) newPostureContinuationPage(flow);
  flow.y = drawSectionHeading(doc, 'Recommended actions', flow.y + 2.5);
  recs.forEach((rec, i) => {
    if (flow.y > flow.bottom) {
      newPostureContinuationPage(flow);
      flow.y = drawSectionHeading(doc, 'Recommended actions (continued)', flow.y + 2.5);
    }
    doc.setFontSize(9);
    set.text(doc, rec.severity === 'bad' ? C.danger : C.warning);
    doc.setFont('helvetica', 'bold');
    doc.text(`${i + 1}.`, PAGE.mx + 1, flow.y);
    set.text(doc, C.ink);
    doc.setFont('helvetica', 'normal');
    doc.text(rec.text, PAGE.mx + 6.5, flow.y);
    flow.y += POSTURE_REC_ROW_HEIGHT;
  });
}

/**
 * The security-product inventory. The whole section moves to the next page
 * when its heading, one product row and the continuation-notice line don't fit
 * (#12043), so the heading never stands alone; a split list says how many rows
 * continue.
 */
function drawPostureProducts(flow: PostureFlow, products: PostureProduct[]): void {
  if (products.length === 0) return;
  const { doc } = flow;
  const headingSpace = 2.5 + 5;
  if (flow.y + headingSpace + POSTURE_PRODUCT_ROW_HEIGHT + POSTURE_PRODUCT_CONTINUATION_SPACE > flow.bottom) {
    newPostureContinuationPage(flow);
  }
  flow.y = drawSectionHeading(doc, 'Security products in use', flow.y + 2.5);
  let next = 0;
  while (next < products.length) {
    const remaining = products.length - next;
    // Rows whose baseline stays above the bottom; when the rest won't all fit,
    // leave a line for the continuation notice instead of clipping a name.
    const fullCapacity = Math.floor((flow.bottom - flow.y) / POSTURE_PRODUCT_ROW_HEIGHT) + 1;
    const take = remaining <= fullCapacity
      ? remaining
      : Math.max(1, Math.floor((flow.bottom - POSTURE_PRODUCT_CONTINUATION_SPACE - flow.y) / POSTURE_PRODUCT_ROW_HEIGHT));
    for (const product of products.slice(next, next + take)) {
      flow.y = drawPostureProductRow(doc, product, flow.y);
    }
    next += take;
    if (next < products.length) {
      const left = products.length - next;
      set.text(doc, C.muted);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(`+ ${left} product${left === 1 ? '' : 's'} continued on the next page`, PAGE.mx + 5, flow.y);
      newPostureContinuationPage(flow);
      flow.y = drawSectionHeading(doc, 'Security products in use (continued)', flow.y + 2.5);
    }
  }
}

// ----------------------------------------------------------------------------
// Executive summary cover: the QBR artifact. Same designed skeleton as the
// posture cover — fleet-health scorecard, thematic metric grids, recommended
// actions — driven by the ExecutiveSummary snapshot instead of posture data.
// ----------------------------------------------------------------------------

const EXEC_STATUS_LABELS: Record<string, string> = {
  maintenance: 'In maintenance',
  updating: 'Updating',
  quarantined: 'Quarantined',
  pending: 'Pending enrollment',
};

/** Headline figure for the cover: the share of managed devices seen in the
 * recent window (#12045) or, for a snapshot written before that field
 * existed, the legacy share online when the report ran. */
function execHeadline(d: NonNullable<ExecutiveSummary['devices']>): { score: number; windowed: boolean; windowDays: number } | null {
  // No managed devices: the snapshot's 100 is a divide-by-zero default, not a
  // measurement, so there is no score to headline.
  if ((d.total ?? 0) === 0) return null;
  if (d.recentlySeenPercentage != null) {
    return { score: d.recentlySeenPercentage, windowed: true, windowDays: d.recentWindowDays ?? 7 };
  }
  if (d.healthPercentage != null) return { score: d.healthPercentage, windowed: false, windowDays: 0 };
  return null;
}

/** Date-only label in the report timezone and the partner's date format,
 *  e.g. "Nov 9, 2026" (#12048). */
function execDate(iso: string, timezone: string): string | null {
  return formatReportDate(iso, { dateFormat: L.dateFormat, timeZone: timezone });
}

const EXEC_ALL_ALERTS_LABEL = 'All recorded alerts';

/**
 * The period the alert figures cover, printed on the cover (#12045). Null
 * for a legacy snapshot that did not record it, so the caller keeps the old
 * wording instead of claiming a period it does not know. Printed as UTC days
 * and labelled, like every other report's period (`formatReportPeriodDay`,
 * #12048 review), so the cover and a threat detection review run beside it
 * print the same days even when it is already tomorrow in UTC.
 */
export function executiveSummaryPeriodLabel(
  period: ExecutiveSummary['period'],
  locale: Pick<ReportLocale, 'dateFormat'> = L,
): string | null {
  if (!period) return null;
  const start = period.start ? formatReportPeriodDay(period.start, locale) : null;
  const end = period.end ? formatReportPeriodDay(period.end, locale) : null;
  if (start && end) return formatReportPeriod(period.start, period.end, locale);
  if (start) return `Since ${start} ${REPORT_PERIOD_ZONE_LABEL}`;
  if (end) return `Through ${end} ${REPORT_PERIOD_ZONE_LABEL}`;
  return EXEC_ALL_ALERTS_LABEL;
}

/**
 * The cover's two metric columns. Left: where every managed device stands —
 * online, offline and every other status, so the rows add up to the managed
 * total — then the windowed figure the score is built on. Right: alert
 * activity. The point-in-time status counts are informational; only the
 * windowed figure carries a pass/fail colour, so one fact is never shown in
 * two severities (#12045).
 */
export function buildExecutiveSummaryMetrics(summary: ExecutiveSummary): { deviceMetrics: Metric[]; alertMetrics: Metric[] } {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const total = d.total ?? 0;
  const online = d.online ?? 0;
  const offline = d.offline ?? 0;

  const deviceMetrics: Metric[] = [
    { label: 'Managed devices', value: String(total), status: 'neutral' },
    { label: 'Online now', value: String(online), status: 'neutral' },
    { label: 'Offline now', value: String(offline), status: 'neutral' },
  ];
  if (d.otherStatuses) {
    for (const [status, count] of Object.entries(d.otherStatuses).sort(([, x], [, z]) => z - x)) {
      if (!count) continue;
      deviceMetrics.push({ label: EXEC_STATUS_LABELS[status] ?? titleCase(status), value: String(count), status: 'neutral' });
    }
  } else {
    // Legacy snapshot: no breakdown was stored, but the remainder still exists.
    const other = total - online - offline;
    if (other > 0) deviceMetrics.push({ label: 'Other status', value: String(other), status: 'neutral' });
  }
  const headline = execHeadline(d);
  deviceMetrics.push(headline?.windowed
    ? {
        label: `Seen in last ${headline.windowDays} days`,
        value: `${d.recentlySeen ?? 0} · ${headline.score}%`,
        status: pctStatus(headline.score),
        target: 'target >=90%',
      }
    : !headline && d.recentlySeenPercentage != null
      // A new-format snapshot of an empty fleet: same wording, no figure.
      ? {
          label: `Seen in last ${d.recentWindowDays ?? 7} days`,
          value: 'N/A',
          status: pctStatus(null),
          target: 'target >=90%',
        }
      : {
        label: 'Online when report ran',
        value: headline ? `${headline.score}%` : 'N/A',
        status: pctStatus(headline?.score),
        target: 'target >=90%',
      });

  const alertMetrics: Metric[] = [
    { label: 'Alerts in period', value: String(a.total ?? 0), status: 'neutral' },
    { label: 'Critical', value: String(a.critical ?? 0), status: (a.critical ?? 0) > 0 ? 'bad' : 'good', target: 'target 0' },
    { label: 'High severity', value: String(a.high ?? 0), status: (a.high ?? 0) > 0 ? 'warn' : 'good', target: 'target 0' },
    { label: 'Resolution rate', value: a.resolutionRate == null ? 'N/A' : `${a.resolutionRate}%`, status: pctStatus(a.resolutionRate, 80, 50), target: 'target >=80%' },
  ];
  return { deviceMetrics, alertMetrics };
}

export function buildExecRecommendations(summary: ExecutiveSummary): Recommendation[] {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const total = d.total ?? 0;
  const recs: Recommendation[] = [];
  if (d.recentlySeenPercentage != null) {
    const days = d.recentWindowDays ?? 7;
    const unseen = Math.max(0, total - (d.recentlySeen ?? 0));
    if (unseen > 0) {
      // The device may simply be switched off or away. What is certain is
      // that its monitoring and patch data has not refreshed (#12045).
      const subject = unseen === 1
        ? `1 device has not reported in for ${days} days — its monitoring and patch status is out of date until it reconnects.`
        : `${unseen} devices have not reported in for ${days} days — their monitoring and patch status is out of date until they reconnect.`;
      recs.push({ severity: pctStatus(d.recentlySeenPercentage) === 'bad' ? 'bad' : 'warn', text: `Follow up: ${subject}` });
    }
  } else if ((d.offline ?? 0) > 0) {
    // Legacy snapshot: only the instant is known, so claim only that.
    const n = d.offline!;
    recs.push({ severity: 'warn', text: `Confirm the ${n} device${n === 1 ? '' : 's'} offline when this report ran ${n === 1 ? 'is' : 'are'} expected to be switched off.` });
  }
  if ((a.critical ?? 0) > 0) {
    // The snapshot's `resolved` count spans all severities, so we can't claim
    // anything about *critical* resolution status — just flag the criticals.
    recs.push({ severity: 'bad', text: `Triage the ${a.critical} critical alert${a.critical === 1 ? '' : 's'} raised in this reporting period.` });
  }
  if (a.resolutionRate != null && a.resolutionRate < 80 && (a.total ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Raise the alert resolution rate — ${a.resolutionRate}% of alerts were resolved against an 80% target.` });
  }
  if ((a.high ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Review ${a.high} high-severity alert${a.high === 1 ? '' : 's'} for recurring patterns worth automating away.` });
  }
  return [...recs.filter((r) => r.severity === 'bad'), ...recs.filter((r) => r.severity === 'warn')];
}

// Characters jsPDF's built-in helvetica (WinAnsi / cp1252) can draw beyond
// Latin-1; anything else renders as garbage with a wrong measured width.
const CP1252_EXTRA = new Set('\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178');
const WINANSI_FOLDS: Record<string, string> = {
  '\u2265': '>=', '\u2264': '<=', '\u2260': '!=', '\u2192': '->', '\u2190': '<-', '\u2194': '<->',
  '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2009': ' ', '\u202f': ' ',
};

/** Make free text (alert titles, hostnames) drawable in the standard font:
 * common symbols fold to ASCII, accented letters outside Latin-1 lose their
 * accent, anything else becomes "?". */
function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    if (ch.codePointAt(0)! <= 0xff || CP1252_EXTRA.has(ch)) {
      out += ch;
    } else if (WINANSI_FOLDS[ch]) {
      out += WINANSI_FOLDS[ch];
    } else {
      const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      out += base && [...base].every((c) => c.codePointAt(0)! <= 0xff) ? base : '?';
    }
  }
  return out;
}

/** Truncate `text` to fit `maxW` at the current font, with an ellipsis. */
function execFit(doc: jsPDF, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 1 && doc.getTextWidth(`${s}…`) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

const EXEC_ROW_H = 5.2;
const EXEC_ALERT_TITLE_MAX_CHARS = 160;

/** Named critical/high alerts, at most `maxRows`. Returns the y after them. */
function drawExecNotableAlerts(
  doc: jsPDF,
  alerts: NonNullable<ExecutiveSummary['notableAlerts']>,
  criticalHighTotal: number,
  maxRows: number,
  top: number,
  timezone: string,
): number {
  const shown = alerts.slice(0, maxRows);
  let y = drawSectionHeading(doc, 'Notable alerts', top);
  const x = PAGE.mx;
  const w = PAGE.w - PAGE.mx * 2;
  const col = { sev: x + 1, title: x + 18, device: x + w - 112, date: x + w - 62, status: x + w - 26 };
  for (const alert of shown) {
    doc.setFontSize(9);
    set.text(doc, alert.severity === 'critical' ? C.danger : C.warning);
    doc.setFont('helvetica', 'bold');
    doc.text(alert.severity === 'critical' ? 'Critical' : 'High', col.sev, y);
    set.text(doc, C.ink);
    doc.setFont('helvetica', 'normal');
    // Alert titles and hostnames come from the stored snapshot: flatten to
    // one line and bound them before they reach the page.
    doc.text(execFit(doc, toWinAnsi(sanitizeNarrativeText(alert.title, EXEC_ALERT_TITLE_MAX_CHARS)), col.device - col.title - 4), col.title, y);
    set.text(doc, C.muted);
    doc.text(execFit(doc, toWinAnsi(sanitizeNarrativeText(alert.device, 80)) || '—', col.date - col.device - 4), col.device, y);
    doc.text(execDate(alert.triggeredAt, timezone) ?? '—', col.date, y);
    doc.text(titleCase(toWinAnsi(sanitizeNarrativeText(alert.status, 24))), col.status, y);
    set.draw(doc, C.rule);
    doc.setLineWidth(0.1);
    doc.line(x, y + 2.1, x + w, y + 2.1);
    y += EXEC_ROW_H;
  }
  const more = criticalHighTotal - shown.length;
  if (more > 0) {
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(`+ ${more} further critical/high alert${more === 1 ? '' : 's'} in this period, listed in Breeze`, PAGE.mx + 1, y);
    y += 4;
  }
  return y;
}

function renderExecutiveSummaryCover(doc: jsPDF, summary: ExecutiveSummary, opts: RenderOpts): void {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const total = d.total ?? 0;
  const period = executiveSummaryPeriodLabel(summary.period);

  const meta = [
    period ? `Reporting period ${period}` : null,
    `Generated ${opts.generatedAt}`,
    `${total} managed device${total === 1 ? '' : 's'}`,
  ].filter(Boolean).join(REPORT_META_SEPARATOR);
  let y = drawTitleBlock(doc, 'Executive Summary', summary.org?.name ?? '', meta, PAGE.bandH + 8);

  const headline = execHeadline(d);
  if (headline) {
    const stats: ScoreStat[] = [
      headline.windowed
        ? { label: `Seen in last ${headline.windowDays} days`, value: `${d.recentlySeen ?? 0}/${total}`, tone: STATUS_COLOR[pctStatus(headline.score)] }
        : { label: 'Online when report ran', value: `${d.online ?? 0}/${total}`, tone: STATUS_COLOR[pctStatus(headline.score)] },
      { label: 'Critical alerts', value: String(a.critical ?? 0), tone: (a.critical ?? 0) > 0 ? C.danger : C.success },
      { label: 'Alerts resolved', value: a.resolutionRate == null ? 'N/A' : `${a.resolutionRate}%`, tone: (a.resolutionRate ?? 100) >= 80 ? C.success : C.warning },
    ];
    // Trend only against a previous run that measured the same thing: a
    // windowed score is never compared with a point-in-time one, and a run
    // with no devices stored a default 100, not a measurement.
    const prevFigure = (key: 'recentlySeenPercentage' | 'healthPercentage') => (s: Record<string, unknown>) => {
      const prev = (s as { devices?: { total?: unknown; recentlySeenPercentage?: unknown; healthPercentage?: unknown } }).devices ?? {};
      return prev.total === 0 ? undefined : prev[key];
    };
    const trend = trendFor(opts, headline.score, prevFigure(headline.windowed ? 'recentlySeenPercentage' : 'healthPercentage'));
    y = drawScorecard(
      doc,
      headline.score,
      headline.windowed
        ? `Fleet availability — managed devices seen in the last ${headline.windowDays} days`
        : 'Fleet health — share of managed devices online when the report ran',
      stats,
      y,
      trend,
    );
    const alertScope = period == null
      ? 'Alert figures cover the configured reporting window.'
      : period === EXEC_ALL_ALERTS_LABEL
        ? 'Alert figures cover all recorded alerts.'
        : `Alert figures cover ${period}.`;
    set.text(doc, C.faint);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(
      headline.windowed
        ? `Fleet availability: managed devices online or last seen in the ${headline.windowDays} days before this report ran. ${alertScope}`
        : `Fleet health: percentage of managed devices online when this report ran. ${alertScope}`,
      PAGE.mx,
      y - 2.5,
    );
    y += 1.5;
  }

  const overviewHeadingY = y + 2;
  y = drawSectionHeading(doc, 'Fleet & alert overview', overviewHeadingY);
  drawLegend(doc, overviewHeadingY);
  // Column-major fill: pad the shorter column so each theme keeps its own.
  const padTo = (arr: Metric[], rows: number): Metric[] =>
    arr.concat(Array.from({ length: rows - arr.length }, () => ({ label: '', value: '', status: 'na' as MetricStatus })));
  const { deviceMetrics, alertMetrics } = buildExecutiveSummaryMetrics(summary);
  const gridRows = Math.max(deviceMetrics.length, alertMetrics.length);
  y = drawMetricGrid(doc, [...padTo(deviceMetrics, gridRows), ...padTo(alertMetrics, gridRows)], y);

  const recs = buildExecRecommendations(summary);
  const notable = summary.notableAlerts ?? [];
  const maxY = PAGE.footY - 4;
  const sectionHead = 2.5 + 5; // gap above a section heading + the heading itself
  const moreLineH = 4;

  // OS + site composition, side by side: left = OS, right = largest sites.
  // Skipped when there is nothing to break down (one OS and one site): two
  // rows repeating the managed total add nothing (#12045). It is the least
  // important section, so it gets only the space left after room for the top
  // two notable alerts and two recommended actions; longer lists fold their
  // tail into one "other" row.
  const osEntries = Object.entries(summary.osDistribution ?? {}).sort(([, x], [, z]) => z - x);
  const sites = summary.siteBreakdown ?? [];
  const reserveFor = (items: number) => (items > 0 ? sectionHead + Math.min(items, 2) * EXEC_ROW_H + moreLineH : 0);
  const compositionRows = Math.min(
    5,
    Math.floor((maxY - y - sectionHead - 3 - reserveFor(notable.length) - reserveFor(recs.length)) / 6),
  );
  if ((osEntries.length > 1 || sites.length > 1) && compositionRows >= 2) {
    y = drawSectionHeading(doc, 'Fleet composition', y + 2.5);
    const devicesLabel = (n: number) => `${n} device${n === 1 ? '' : 's'}`;
    const fold = (entries: Array<[string, number]>, otherLabel: (n: number) => string): Metric[] => {
      const shown = entries.length > compositionRows ? entries.slice(0, compositionRows - 1) : entries;
      const metrics: Metric[] = shown.map(([label, count]) => ({ label, value: devicesLabel(count), status: 'neutral' }));
      if (entries.length > compositionRows) {
        const rest = entries.slice(compositionRows - 1);
        metrics.push({ label: otherLabel(rest.length), value: devicesLabel(rest.reduce((acc, [, n]) => acc + n, 0)), status: 'neutral' });
      }
      return metrics;
    };
    const osMetrics = fold(
      osEntries.map(([os, count]): [string, number] => [OS_LABELS[os.toLowerCase()] ?? titleCase(os), count]),
      (n) => `${n} other operating system${n === 1 ? '' : 's'}`,
    );
    const siteMetrics = fold(sites.map((st): [string, number] => [st.site, st.count]), (n) => `${n} other site${n === 1 ? '' : 's'}`);
    const rows = Math.max(osMetrics.length, siteMetrics.length);
    y = drawMetricGrid(doc, [...padTo(osMetrics, rows), ...padTo(siteMetrics, rows)], y);
  }


  // Name the critical/high alerts the counts summarise (#12045), in the space
  // left after reserving room for the recommended actions below.
  const criticalHigh = (a.critical ?? 0) + (a.high ?? 0);
  if (notable.length > 0) {
    // Rows that fit after reserving the recommended actions: all of them
    // first, else room for only the top two, so a dense cover still names its
    // worst alerts (the actions below then say what they had to cut).
    const rowsWith = (reservedRecs: number) => {
      const reserve = reservedRecs > 0 ? sectionHead + reservedRecs * EXEC_ROW_H + moreLineH : 0;
      return Math.min(notable.length, Math.floor((maxY - reserve - y - sectionHead - moreLineH) / EXEC_ROW_H));
    };
    let alertRows = rowsWith(Math.min(recs.length, 5));
    if (alertRows < 1) alertRows = rowsWith(Math.min(recs.length, 2));
    if (alertRows > 0) {
      y = drawExecNotableAlerts(doc, notable, criticalHigh, alertRows, y + 2.5, opts.timezone);
    } else if (y + 2.5 + moreLineH <= maxY) {
      set.text(doc, C.muted);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(`${criticalHigh} critical/high alert${criticalHigh === 1 ? '' : 's'} in this period, listed in Breeze`, PAGE.mx + 1, y + 2.5);
      y += 2.5 + moreLineH;
    }
  }

  // Recommended actions close the page — the reader leaves with next steps.
  if (recs.length > 0 && y + sectionHead + EXEC_ROW_H <= maxY) {
    let fit = Math.min(recs.length, 5, Math.floor((maxY - y - sectionHead) / EXEC_ROW_H));
    // Keep a line to say what was cut rather than dropping it unannounced.
    if (fit < recs.length && fit > 1 && y + sectionHead + fit * EXEC_ROW_H + moreLineH > maxY) fit -= 1;
    y = drawSectionHeading(doc, 'Recommended actions', y + 2.5);
    doc.setFontSize(9);
    recs.slice(0, fit).forEach((rec, i) => {
      set.text(doc, rec.severity === 'bad' ? C.danger : C.warning);
      doc.setFont('helvetica', 'bold');
      doc.text(`${i + 1}.`, PAGE.mx + 1, y);
      set.text(doc, C.ink);
      doc.setFont('helvetica', 'normal');
      doc.text(rec.text, PAGE.mx + 6.5, y);
      y += EXEC_ROW_H;
    });
    const cut = recs.length - fit;
    if (cut > 0) {
      set.text(doc, C.muted);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(`+ ${cut} further recommendation${cut === 1 ? '' : 's'} available in Breeze`, PAGE.mx + 6.5, y);
    }
  }
}

// ----------------------------------------------------------------------------
// Weekly AI narrative: title block + headline + one heading per section (in
// the server-fixed NARRATIVE_SECTION_KEYS order, using NARRATIVE_SECTION_TITLES
// — never a stored title, never an unknown key) with wrapped, page-break-aware
// bullets. Unlike the posture/exec covers (bounded to one page by construction)
// a narrative's bullet volume is model-authored and unbounded up to the schema
// caps, so this arm draws its OWN chrome per page as it paginates, exactly like
// `renderGenericReport`'s autoTable path — `buildReportPdf` does not draw
// header/footer again after calling it.
// ----------------------------------------------------------------------------

/** Everything under `OrgNarrativeReportSummary.narrative`, non-optional. */
type NarrativeSnapshot = NonNullable<OrgNarrativeReportSummary['narrative']>;

const NARRATIVE_LINE_H = 4.3; // wrapped body-line height at fontSize 9
const NARRATIVE_HEADLINE_LINE_H = 5.4; // wrapped headline-line height at fontSize 10.5
const NARRATIVE_BULLET_INDENT = 5; // marker + gap before bullet text, matches drawPostureProductRow
const NARRATIVE_BULLET_GAP = 1.6; // vertical gap after a bullet block, before the next bullet
const NARRATIVE_SECTION_GAP = 2.5; // vertical gap after a section's last bullet, before the next heading
const narrativeContentBottom = (): number => PAGE.footY - 8; // keep clear of the footnote line above the footer rule
// org/agent display names come from the same unvalidated jsonb summary blob as
// bullets (legacy/hand-built snapshots included), so they get the same
// sanitizeNarrativeText treatment before reaching the header chrome — a
// generous cap since these are short display names, not prose.
const NARRATIVE_NAME_MAX_CHARS = 120;

/**
 * Collapse one model-authored (or legacy/hand-built) narrative string to a
 * safe, single-line, length-bounded value for direct rendering.
 *
 * Every `\p{C}` codepoint (C0/C1 controls, zero-width chars, the U+202E RTL
 * override) becomes a space so an embedded newline — e.g. a bullet reading
 * `"Deployed patch\n- injected"` — can never introduce a real line break and
 * masquerade as a second, visually indistinguishable bullet; runs of
 * whitespace then collapse so the result reads as one continuous line.
 * Mirrors `flattenNarrativeLine` in `validators/orgNarrative.ts` (same
 * threat, same fix) without importing zod into this dependency-free
 * rendering module.
 *
 * The length cap applies to the FLATTENED result, not the raw input: this is
 * a render-time belt-and-braces behind the intake schema's own cap, guarding
 * the sections/markdown a legacy snapshot or hand-built `NarrativeSection[]`
 * may carry without ever having gone through `narrativeSubmissionSchema`.
 */
export function sanitizeNarrativeText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? flat.slice(0, maxChars).trim() : flat;
}

function formatNarrativeIsoDate(iso: unknown): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  return formatReportDate(iso, L);
}

function narrativePeriodLabel(narrative: NarrativeSnapshot): string {
  const start = formatNarrativeIsoDate(narrative.periodStart);
  const end = formatNarrativeIsoDate(narrative.periodEnd);
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? '';
}

function drawNarrativeFootnote(doc: jsPDF): void {
  set.text(doc, C.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(
    'Generated by an AI agent from the previous 7 days of Breeze data; numbers are as recorded, narrative is model-authored.',
    PAGE.mx,
    PAGE.footY - 2,
  );
}

/** Finish the outgoing page's chrome, start a fresh one, and return its content-start y. */
function narrativePageBreak(doc: jsPDF, opts: RenderOpts): number {
  drawHeaderBand(doc, opts);
  drawFooter(doc, opts);
  drawNarrativeFootnote(doc);
  doc.addPage();
  return PAGE.bandH + 10;
}

/** Page-break-aware vertical budget check: rolls onto a fresh page (with chrome
 * drawn on the outgoing one) when `neededH` would run into the footer zone. */
function ensureNarrativeRoom(doc: jsPDF, opts: RenderOpts, y: number, neededH: number): number {
  return y + neededH > narrativeContentBottom() ? narrativePageBreak(doc, opts) : y;
}

function renderNarrativeReport(doc: jsPDF, narrative: NarrativeSnapshot, opts: RenderOpts): void {
  const orgName = sanitizeNarrativeText(narrative.orgName, NARRATIVE_NAME_MAX_CHARS);
  const agentName = sanitizeNarrativeText(narrative.agentName, NARRATIVE_NAME_MAX_CHARS);
  const period = narrativePeriodLabel(narrative);

  const metaParts = [`Generated ${opts.generatedAt}`];
  if (period) metaParts.push(period);
  if (agentName) metaParts.push(`Agent: ${agentName}`);

  let y = drawTitleBlock(doc, 'Weekly AI Operations Narrative', orgName, metaParts.join(REPORT_META_SEPARATOR), PAGE.bandH + 8);

  const headline = sanitizeNarrativeText(narrative.headline, NARRATIVE_HEADLINE_MAX_CHARS);
  if (headline) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    const wrapped = doc.splitTextToSize(headline, PAGE.w - PAGE.mx * 2) as string[];
    const blockH = wrapped.length * NARRATIVE_HEADLINE_LINE_H;
    y = ensureNarrativeRoom(doc, opts, y, blockH);
    set.text(doc, C.ink);
    doc.text(wrapped, PAGE.mx, y);
    y += blockH + 3;
  }

  // Closed, exhaustive iteration over NARRATIVE_SECTION_KEYS (never the stored
  // `sections` array order) is what makes an unknown/renamed key structurally
  // unrenderable — a section this loop never visits can never draw a heading
  // or a bullet, regardless of what a legacy or hand-built snapshot contains.
  const sectionsByKey = new Map<string, { bullets: unknown }>();
  const rawSections = Array.isArray(narrative.sections) ? narrative.sections : [];
  for (const section of rawSections) {
    if (section && typeof section.key === 'string' && !sectionsByKey.has(section.key)) {
      sectionsByKey.set(section.key, section);
    }
  }

  for (const key of NARRATIVE_SECTION_KEYS) {
    const bullets = sectionsByKey.get(key)?.bullets;
    if (!Array.isArray(bullets) || bullets.length === 0) continue;

    y = ensureNarrativeRoom(doc, opts, y, 5 + NARRATIVE_LINE_H);
    y = drawSectionHeading(doc, NARRATIVE_SECTION_TITLES[key], y);

    for (const rawBullet of bullets) {
      const text = sanitizeNarrativeText(rawBullet, NARRATIVE_BULLET_MAX_CHARS);
      if (!text) continue;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const wrapped = doc.splitTextToSize(text, PAGE.w - PAGE.mx * 2 - NARRATIVE_BULLET_INDENT) as string[];
      const blockH = wrapped.length * NARRATIVE_LINE_H;
      y = ensureNarrativeRoom(doc, opts, y, blockH);
      set.fill(doc, C.teal);
      doc.circle(PAGE.mx + 1.2, y - 1.4, 0.9, 'F');
      set.text(doc, C.ink);
      doc.text(wrapped, PAGE.mx + NARRATIVE_BULLET_INDENT, y);
      y += blockH + NARRATIVE_BULLET_GAP;
    }
    y += NARRATIVE_SECTION_GAP;
  }

  // Chrome for the final page — every earlier page got its chrome from
  // narrativePageBreak() when we rolled off of it.
  drawHeaderBand(doc, opts);
  drawFooter(doc, opts);
  drawNarrativeFootnote(doc);
}

// ----------------------------------------------------------------------------
// Fleet Design: title block + one heading per section (server-fixed
// FLEET_DESIGN_SECTION_KEYS order, FLEET_DESIGN_SECTION_TITLES — never a
// stored title, never an unknown key), bullets for prose-shaped sections and
// autoTable grids for tabular ones. Every field of
// `FleetDesignReportSummary['fleetDesign']` (and everything nested under its
// optional `outcome`) is optional/defensively read: a legacy or partial
// snapshot must render without throwing, drawing only what it has.
//
// Like `renderNarrativeReport`, this arm draws its OWN chrome per page as it
// paginates (model/table volume is unbounded up to the schema caps) —
// `buildReportPdf` does not draw header/footer again after calling it.
// ----------------------------------------------------------------------------

/** Everything under `FleetDesignReportSummary.fleetDesign`, non-optional. */
type FleetDesignSnapshot = NonNullable<FleetDesignReportSummary['fleetDesign']>;

function drawFleetDesignFootnote(doc: jsPDF): void {
  set.text(doc, C.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text('Proposals only — nothing here is live until a technician applies it.', PAGE.mx, PAGE.footY - 2);
}

/** Finish the outgoing page's chrome, start a fresh one, and return its content-start y. */
function fleetDesignPageBreak(doc: jsPDF, opts: RenderOpts): number {
  drawHeaderBand(doc, opts);
  drawFooter(doc, opts);
  drawFleetDesignFootnote(doc);
  doc.addPage();
  return PAGE.bandH + 10;
}

/** Page-break-aware vertical budget check, mirroring `ensureNarrativeRoom` but
 * with the Fleet Design footnote drawn on the outgoing page. */
function ensureFleetDesignRoom(doc: jsPDF, opts: RenderOpts, y: number, neededH: number): number {
  return y + neededH > narrativeContentBottom() ? fleetDesignPageBreak(doc, opts) : y;
}

/** `jspdf-autotable` stamps `doc.lastAutoTable.finalY` at runtime but does not
 * declare it in its shipped types (dist/index.d.ts has no such export). */
function fleetDesignAutoTableFinalY(doc: jsPDF, fallback: number): number {
  const t = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  return typeof t?.finalY === 'number' ? t.finalY : fallback;
}

/** Sanitize a possibly-non-string, possibly-absent field the same way a
 * narrative bullet is sanitized before it can reach jsPDF. */
function fdText(value: unknown, max = NARRATIVE_BULLET_MAX_CHARS): string {
  return sanitizeNarrativeText(value, max);
}

/** Map+sanitize+drop-empty over a value that should be an array but — coming
 * from an unvalidated jsonb blob (legacy/hand-built snapshots included) —
 * might not be. */
function fdList(arr: unknown, mapper: (item: unknown) => string): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(mapper).filter((s) => s.length > 0);
}

function fmtPct(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
}

/** Shared bullet-list renderer for the Fleet Design report's prose sections
 * (found/baseline/unsure/automation) — same shape as the narrative bullet
 * loop: sanitize, wrap, page-break-aware, teal marker dot. */
function drawFleetDesignBullets(doc: jsPDF, opts: RenderOpts, lines: string[], y: number): number {
  for (const raw of lines) {
    const text = fdText(raw);
    if (!text) continue;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const wrapped = doc.splitTextToSize(text, PAGE.w - PAGE.mx * 2 - NARRATIVE_BULLET_INDENT) as string[];
    const blockH = wrapped.length * NARRATIVE_LINE_H;
    y = ensureFleetDesignRoom(doc, opts, y, blockH);
    set.fill(doc, C.teal);
    doc.circle(PAGE.mx + 1.2, y - 1.4, 0.9, 'F');
    set.text(doc, C.ink);
    doc.text(wrapped, PAGE.mx + NARRATIVE_BULLET_INDENT, y);
    y += blockH + NARRATIVE_BULLET_GAP;
  }
  return y;
}

/** Shared autoTable option block for the Fleet Design report's grids — the
 * posture table's style block (:1319-1340 pre-edit) minus `didParseCell`
 * (posture-specific cell colouring; nothing here needs it). */
function drawFleetDesignTable(doc: jsPDF, opts: RenderOpts, head: string[][], body: string[][], y: number): number {
  autoTable(doc, {
    startY: y,
    margin: { top: PAGE.bandH + 6, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
    head,
    body,
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: 7.5, cellPadding: 1.8, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7.5, lineColor: C.white, lineWidth: 0.15 },
    alternateRowStyles: { fillColor: C.zebra },
    didDrawPage: () => {
      drawHeaderBand(doc, opts);
      drawFooter(doc, opts);
      drawFleetDesignFootnote(doc);
    },
  });
  return fleetDesignAutoTableFinalY(doc, y) + 6;
}

function drawFleetDesignSubheading(doc: jsPDF, text: string, y: number): number {
  set.text(doc, C.primary);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(text, PAGE.mx, y);
  return y + 4.5;
}

function fleetDesignFoundBullets(found: unknown): string[] {
  const f = (found ?? {}) as { summary?: unknown; findings?: unknown };
  return [
    ...fdList(f.summary, (s) => fdText(s)),
    ...fdList(f.findings, (item) => {
      const finding = item as { title?: unknown; deviceCount?: unknown; evidence?: unknown };
      const title = fdText(finding.title);
      if (!title) return '';
      const count = typeof finding.deviceCount === 'number' ? finding.deviceCount : null;
      const countPart = count == null ? '' : ` (${count} device${count === 1 ? '' : 's'})`;
      const evidence = fdList(finding.evidence, (e) => fdText(e)).join('; ');
      return evidence ? `${title}${countPart} — ${evidence}` : `${title}${countPart}`;
    }),
  ];
}

function drawFleetDesignFunctionsTable(doc: jsPDF, opts: RenderOpts, functions: unknown, y: number): number {
  if (!Array.isArray(functions) || functions.length === 0) return y;
  const body = functions.map((item) => {
    const f = item as { functionKey?: unknown; label?: unknown; deviceIds?: unknown; confidence?: unknown; evidence?: unknown };
    const label = fdText(f.label) || fdText(f.functionKey) || '—';
    const deviceCount = Array.isArray(f.deviceIds) ? f.deviceIds.length : 0;
    const evidence = fdList(f.evidence, (e) => fdText(e)).join('; ') || '—';
    return [label, String(deviceCount), fmtPct(f.confidence), evidence];
  });
  return drawFleetDesignTable(doc, opts, [['Function', 'Devices', 'Confidence', 'Evidence']], body, y);
}

function drawFleetDesignMonitoringSection(doc: jsPDF, opts: RenderOpts, monitoring: unknown, y: number): number {
  if (!Array.isArray(monitoring) || monitoring.length === 0) return y;
  for (const item of monitoring) {
    const m = item as { functionKey?: unknown; watches?: unknown; alertRules?: unknown };
    const label = fdText(m.functionKey) || '—';
    y = ensureFleetDesignRoom(doc, opts, y, 6);
    y = drawFleetDesignSubheading(doc, label, y);

    const watches = Array.isArray(m.watches) ? m.watches : [];
    if (watches.length > 0) {
      const body = watches.map((w) => {
        const watch = w as { watchType?: unknown; name?: unknown; alertOnStop?: unknown; autoRestart?: unknown; rationale?: unknown };
        return [
          fdText(watch.watchType) || '—',
          fdText(watch.name) || '—',
          watch.alertOnStop ? 'Yes' : 'No',
          watch.autoRestart ? 'Yes' : 'No',
          fdText(watch.rationale, FLEET_DESIGN_TEXT_MAX_CHARS) || '—',
        ];
      });
      y = drawFleetDesignTable(doc, opts, [['Type', 'Name', 'Alert on stop', 'Auto-restart', 'Rationale']], body, y);
    }

    const rules = Array.isArray(m.alertRules) ? m.alertRules : [];
    if (rules.length > 0) {
      const body = rules.map((r) => {
        const rule = r as { name?: unknown; severity?: unknown; cooldownMinutes?: unknown; paging?: unknown; rationale?: unknown };
        return [
          fdText(rule.name) || '—',
          fdText(rule.severity) || '—',
          typeof rule.cooldownMinutes === 'number' ? `${rule.cooldownMinutes}m` : '—',
          fdText(rule.paging) || '—',
          fdText(rule.rationale, FLEET_DESIGN_TEXT_MAX_CHARS) || '—',
        ];
      });
      y = drawFleetDesignTable(doc, opts, [['Name', 'Severity', 'Cooldown', 'Paging', 'Rationale']], body, y);
    }
  }
  return y;
}

function drawFleetDesignRetiredTable(doc: jsPDF, opts: RenderOpts, retired: unknown, y: number): number {
  if (!Array.isArray(retired) || retired.length === 0) return y;
  const body = retired.map((item) => {
    const r = item as { kind?: unknown; itemName?: unknown; policyName?: unknown; reason?: unknown };
    return [fdText(r.kind) || '—', fdText(r.itemName) || '—', fdText(r.policyName) || '—', fdText(r.reason, FLEET_DESIGN_TEXT_MAX_CHARS) || '—'];
  });
  return drawFleetDesignTable(doc, opts, [['Kind', 'Item', 'Policy', 'Reason']], body, y);
}

function drawFleetDesignAutomationBullets(automation: unknown): string[] {
  if (!Array.isArray(automation)) return [];
  const bullets: string[] = [];
  for (const item of automation) {
    const a = item as { functionKey?: unknown; playbooks?: unknown; scripts?: unknown };
    const fk = fdText(a.functionKey) || '—';
    for (const pb of Array.isArray(a.playbooks) ? a.playbooks : []) {
      const p = (pb ?? {}) as { builtInName?: unknown; custom?: unknown };
      if (typeof p.builtInName === 'string') {
        const name = fdText(p.builtInName);
        if (name) bullets.push(`${fk}: playbook "${name}"`);
      } else if (p.custom && typeof p.custom === 'object') {
        const c = p.custom as { name?: unknown; description?: unknown };
        const name = fdText(c.name);
        const desc = fdText(c.description, FLEET_DESIGN_TEXT_MAX_CHARS);
        if (name) bullets.push(desc ? `${fk}: custom playbook "${name}" — ${desc}` : `${fk}: custom playbook "${name}"`);
      }
    }
    for (const sc of Array.isArray(a.scripts) ? a.scripts : []) {
      const s = (sc ?? {}) as { name?: unknown; purpose?: unknown };
      const name = fdText(s.name);
      const purpose = fdText(s.purpose, FLEET_DESIGN_TEXT_MAX_CHARS);
      if (name) bullets.push(purpose ? `${fk}: script "${name}" — ${purpose}` : `${fk}: script "${name}"`);
    }
  }
  return bullets;
}

function drawFleetDesignLegacyTable(doc: jsPDF, opts: RenderOpts, legacy: unknown, y: number): number {
  if (!Array.isArray(legacy) || legacy.length === 0) return y;
  const body = legacy.map((item) => {
    const l = item as { scriptName?: unknown; bucket?: unknown; coveredBy?: unknown; intent?: unknown };
    return [fdText(l.scriptName) || '—', fdText(l.bucket) || '—', fdText(l.coveredBy) || '—', fdText(l.intent, FLEET_DESIGN_TEXT_MAX_CHARS) || '—'];
  });
  return drawFleetDesignTable(doc, opts, [['Script', 'Bucket', 'Covered by', 'Intent']], body, y);
}

function fleetDesignBaselineBullets(baseline: unknown): string[] {
  const b = (baseline ?? {}) as { notes?: unknown; numbers?: unknown };
  const numbers = (b.numbers ?? {}) as { alertsPer100EndpointsPerMonth?: unknown; ticketsPerMonth?: unknown; precursors?: unknown };
  const bullets: string[] = [];
  if (typeof numbers.alertsPer100EndpointsPerMonth === 'number') {
    bullets.push(`Alerts per 100 endpoints per month: ${numbers.alertsPer100EndpointsPerMonth}`);
  }
  if (typeof numbers.ticketsPerMonth === 'number') {
    bullets.push(`Tickets per month: ${numbers.ticketsPerMonth}`);
  }
  bullets.push(...fdList(numbers.precursors, (p) => {
    const precursor = (p ?? {}) as { condition?: unknown; deviceCount?: unknown };
    const condition = fdText(precursor.condition);
    if (!condition) return '';
    const label = titleCase(condition);
    const count = typeof precursor.deviceCount === 'number' ? precursor.deviceCount : null;
    return count == null ? label : `${label}: ${count} device${count === 1 ? '' : 's'}`;
  }));
  bullets.push(...fdList(b.notes, (n) => fdText(n)));
  return bullets;
}

function fleetDesignUnsureBullets(unsure: unknown): string[] {
  const u = (unsure ?? {}) as {
    lowConfidenceFunctions?: unknown; unreachableDevices?: unknown; needsHuman?: unknown; roleCorrections?: unknown;
  };
  const bullets: string[] = [];
  bullets.push(...fdList(u.lowConfidenceFunctions, (item) => {
    const f = (item ?? {}) as { functionKey?: unknown; label?: unknown; deviceIds?: unknown; confidence?: unknown; evidence?: unknown };
    const label = fdText(f.label) || fdText(f.functionKey);
    if (!label) return '';
    const count = Array.isArray(f.deviceIds) ? f.deviceIds.length : 0;
    const evidence = fdList(f.evidence, (e) => fdText(e)).join('; ');
    return `Low-confidence function: ${label} — ${count} device${count === 1 ? '' : 's'}, confidence ${fmtPct(f.confidence)}${evidence ? ` — ${evidence}` : ''}`;
  }));
  bullets.push(...fdList(u.unreachableDevices, (id) => {
    const t = fdText(id);
    return t ? `Unreachable device: ${t}` : '';
  }));
  bullets.push(...fdList(u.needsHuman, (n) => fdText(n)));
  bullets.push(...fdList(u.roleCorrections, (item) => {
    const r = (item ?? {}) as { deviceId?: unknown; currentRole?: unknown; proposedRole?: unknown; evidence?: unknown };
    const deviceId = fdText(r.deviceId);
    if (!deviceId) return '';
    const current = fdText(r.currentRole) || '—';
    const proposed = fdText(r.proposedRole) || '—';
    const evidence = fdList(r.evidence, (e) => fdText(e)).join('; ');
    return `Role correction: device ${deviceId} ${current} -> ${proposed}${evidence ? ` — ${evidence}` : ''}`;
  }));
  return bullets;
}

/**
 * W05 (#5655): the server-computed drift between the approved (applied)
 * design and the live fleet. Drawn FIRST — before the eight sections — because
 * on a scheduled re-run it is the finding a technician opens the report for.
 * Rows are read defensively (persisted jsonb) exactly like the sections.
 */
function drawFleetDesignDriftSection(doc: jsPDF, opts: RenderOpts, drift: unknown, y: number): number {
  if (!drift || typeof drift !== 'object') return y;
  const d = drift as { appliedAt?: unknown; missing?: unknown; extra?: unknown; changed?: unknown };
  const missing = Array.isArray(d.missing) ? d.missing : [];
  const extra = Array.isArray(d.extra) ? d.extra : [];
  const changed = Array.isArray(d.changed) ? d.changed : [];
  const appliedAt = fdText(d.appliedAt, 10);

  y = ensureFleetDesignRoom(doc, opts, y, 5 + NARRATIVE_LINE_H);
  y = drawSectionHeading(doc, 'Drift since the approved design', y);
  const summaryLine = `Design applied ${appliedAt || '—'}: ${missing.length} missing, ${extra.length} extra, ${changed.length} changed.`;
  y = drawFleetDesignBullets(doc, opts, [summaryLine], y);

  const body: string[][] = [];
  for (const item of missing) {
    const m = (item ?? {}) as { functionKey?: unknown; kind?: unknown; name?: unknown };
    body.push(['Missing', fdText(m.kind) || '—', fdText(m.name) || '—', fdText(m.functionKey) || '—', '—']);
  }
  for (const item of changed) {
    const c = (item ?? {}) as { functionKey?: unknown; kind?: unknown; name?: unknown; field?: unknown; approved?: unknown; live?: unknown };
    body.push(['Changed', fdText(c.kind) || '—', fdText(c.name) || '—', fdText(c.functionKey) || '—', `${fdText(c.field)}: ${fdText(c.approved)} -> ${fdText(c.live)}`]);
  }
  for (const item of extra) {
    const e = (item ?? {}) as { policyName?: unknown; kind?: unknown; name?: unknown; deviceCount?: unknown };
    const count = typeof e.deviceCount === 'number' ? `${e.deviceCount} device${e.deviceCount === 1 ? '' : 's'}` : '—';
    body.push(['Extra', fdText(e.kind) || '—', fdText(e.name) || '—', fdText(e.policyName) || '—', count]);
  }
  if (body.length) y = drawFleetDesignTable(doc, opts, [['Drift', 'Kind', 'Item', 'Function / policy', 'Detail']], body, y);
  return y + NARRATIVE_SECTION_GAP;
}

function renderFleetDesignReport(doc: jsPDF, fd: FleetDesignSnapshot, opts: RenderOpts): void {
  const orgName = fdText(fd.orgName, NARRATIVE_NAME_MAX_CHARS);
  const agentName = fdText(fd.agentName, NARRATIVE_NAME_MAX_CHARS);
  const siteName = fdText(fd.siteName, NARRATIVE_NAME_MAX_CHARS);

  const metaParts = [`Generated ${opts.generatedAt}`];
  if (agentName) metaParts.push(`Agent: ${agentName}`);
  if (siteName) metaParts.push(`Site: ${siteName}`);

  let y = drawTitleBlock(doc, 'Fleet Design', orgName, metaParts.join(REPORT_META_SEPARATOR), PAGE.bandH + 8);

  // Provenance line: a section whose loader failed was never measured, so a
  // reader must not take a 0 in the baseline as a finding.
  const unavailable = Array.isArray(fd.unavailable)
    ? fd.unavailable.map((s) => fdText(s, NARRATIVE_NAME_MAX_CHARS)).filter(Boolean)
    : [];
  if (unavailable.length) {
    set.text(doc, C.faint);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.text(`Not measured: ${unavailable.join(', ')}`, PAGE.mx, y);
    y += NARRATIVE_LINE_H + 2;
  }

  // W05: drift first, when present. Not one of the eight submission sections.
  if (fd.drift) y = drawFleetDesignDriftSection(doc, opts, fd.drift, y);

  // Closed, exhaustive iteration over FLEET_DESIGN_SECTION_KEYS (never a
  // stored key order) is what makes an unknown/renamed key structurally
  // unrenderable. `sections` itself is only present when `outcome` is —
  // an outcome-less snapshot (old/partial persisted summary) renders just
  // the title block above, which is the intended degraded-but-safe result.
  const sections = fd.outcome?.sections;
  if (sections) {
    for (const key of FLEET_DESIGN_SECTION_KEYS) {
      y = ensureFleetDesignRoom(doc, opts, y, 5 + NARRATIVE_LINE_H);
      y = drawSectionHeading(doc, FLEET_DESIGN_SECTION_TITLES[key], y);
      switch (key) {
        case 'found':
          y = drawFleetDesignBullets(doc, opts, fleetDesignFoundBullets(sections.found), y);
          break;
        case 'functions':
          y = drawFleetDesignFunctionsTable(doc, opts, sections.functions, y);
          break;
        case 'monitoring':
          y = drawFleetDesignMonitoringSection(doc, opts, sections.monitoring, y);
          break;
        case 'retired':
          y = drawFleetDesignRetiredTable(doc, opts, sections.retired, y);
          break;
        case 'automation':
          y = drawFleetDesignBullets(doc, opts, drawFleetDesignAutomationBullets(sections.automation), y);
          break;
        case 'legacy':
          y = drawFleetDesignLegacyTable(doc, opts, sections.legacy, y);
          break;
        case 'baseline':
          y = drawFleetDesignBullets(doc, opts, fleetDesignBaselineBullets(sections.baseline), y);
          break;
        case 'unsure':
          y = drawFleetDesignBullets(doc, opts, fleetDesignUnsureBullets(sections.unsure), y);
          break;
      }
      y += NARRATIVE_SECTION_GAP;
    }
  }

  // Chrome for the final page — every earlier page got its chrome from
  // fleetDesignPageBreak()/drawFleetDesignTable()'s didDrawPage when we
  // rolled off of it.
  drawHeaderBand(doc, opts);
  drawFooter(doc, opts);
  drawFleetDesignFootnote(doc);
}

// ----------------------------------------------------------------------------
// Per-device detail table (curated columns + per-cell colour for posture).
// ----------------------------------------------------------------------------

type PostureCol = { key: string; label: string; w: number; halign: 'left' | 'center' };

const POSTURE_COLUMNS: PostureCol[] = [
  { key: 'hostname', label: 'Hostname', w: 34, halign: 'left' },
  { key: 'os', label: 'OS', w: 16, halign: 'left' },
  { key: 'site', label: 'Site', w: 24, halign: 'left' },
  { key: 'protection', label: 'Protection', w: 30, halign: 'left' },
  { key: 'avDefinitionsAgeDays', label: 'AV Age (days)', w: 16, halign: 'center' },
  { key: 'encryption', label: 'Encryption', w: 22, halign: 'center' },
  { key: 'firewall', label: 'Firewall', w: 16, halign: 'center' },
  { key: 'localAdmins', label: 'Local Admins', w: 19, halign: 'center' },
  { key: 'pendingPatches', label: 'Pending', w: 16, halign: 'center' },
  { key: 'criticalPatches', label: 'Critical', w: 16, halign: 'center' },
  { key: 'openVulnHigh', label: 'High', w: 16, halign: 'center' },
  { key: 'openVulnCritical', label: 'Critical', w: 16, halign: 'center' },
  { key: 'cisPassRate', label: 'CIS %', w: 14, halign: 'center' },
];

// Column groups rendered as a spanning first header row, so "Pending" and
// "Critical" unambiguously read as *patch* counts next to the vuln pair.
const POSTURE_COLUMN_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Patches', keys: ['pendingPatches', 'criticalPatches'] },
  { label: 'Vulnerabilities', keys: ['openVulnHigh', 'openVulnCritical'] },
];

const num = (v: unknown): number | null =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null;

const OS_LABELS: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  darwin: 'macOS',
  linux: 'Linux',
};

const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  antivirus: 'Antivirus',
  edr: 'EDR',
  mdr: 'MDR',
  dns_filtering: 'DNS filtering',
  backup: 'Backup',
  identity: 'Identity',
};

const POSTURE_PRODUCT_ROW_HEIGHT = 5.2;
const POSTURE_PRODUCT_CONTINUATION_SPACE = 4;

function drawPostureProductRow(doc: jsPDF, product: PostureProduct, y: number): number {
  const catLabel = PRODUCT_CATEGORY_LABELS[product.category] ?? product.category;
  // Skip the category tag when the product name already conveys it
  // (avoids "Backup (local) (Backup)").
  const cat = product.product.toLowerCase().includes(catLabel.toLowerCase()) ? '' : ` (${catLabel})`;
  const coverage = product.deviceCoverage != null
    ? ` — ${product.deviceCoverage} device${product.deviceCoverage === 1 ? '' : 's'}`
    : '';
  // "Installed on N" reads as "protecting N". When only a subset of those devices
  // are actually protecting (native AV with real-time protection on; a backup
  // product with a successful backup in the window), spell that out so one
  // active device can't imply full-fleet coverage (issue #2517). The wording
  // follows the category — "real-time protection" means nothing for a backup
  // product (#6012).
  const activeCount = product.activeDeviceCoverage;
  const activeNote = product.category === 'backup'
    ? 'with a successful backup in the period'
    : 'with real-time protection on';
  const rtpNote =
    product.deviceCoverage != null && activeCount != null && activeCount < product.deviceCoverage
      ? `, ${activeCount} ${activeNote}`
      : '';
  // Sync status is only interesting when it's a problem; success is machine
  // noise on a client-facing page.
  const syncOk = !product.lastSyncStatus || /^(ok|success|succeeded)$/i.test(product.lastSyncStatus);
  const sync = syncOk ? '' : ` — sync ${product.lastSyncStatus}`;
  const degraded = product.active === false ? ' — not reporting' : '';
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  set.fill(doc, product.active === false ? C.warning : C.success);
  doc.circle(PAGE.mx + 1.4, y - 1.2, 1.2, 'F');
  set.text(doc, C.ink);
  doc.text(`${product.product}${cat}${coverage}${rtpNote}`, PAGE.mx + 5, y);
  if (sync || degraded) {
    const baseW = doc.getTextWidth(`${product.product}${cat}${coverage}${rtpNote}`);
    set.text(doc, C.warning);
    doc.text(`${sync}${degraded}`, PAGE.mx + 5 + baseW, y);
  }
  return y + POSTURE_PRODUCT_ROW_HEIGHT;
}

/** Colour for a posture body cell, keyed by column. null = inherit default ink. */
function postureCellColor(key: string, raw: unknown): RGB | null {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const n = num(raw);
  // Empty-value guard applies to null/missing and blank-ish strings only —
  // booleans must fall through to the per-column rules (a bare `s === ''`
  // check used to swallow firewall true/false into faint gray).
  if (raw == null || (typeof raw === 'string' && (s === '' || s === 'no data' || s === 'n/a' || s === '—'))) {
    return C.faint;
  }
  switch (key) {
    case 'firewall':
      return raw === true || s === 'yes' ? C.success : raw === false || s === 'no' ? C.danger : null;
    case 'encryption':
      // Negative forms first: "unencrypted" contains "encrypt" and must not
      // match the positive pattern.
      return /unencrypt|not encrypt|\bno\b|\boff\b|disabled/.test(s)
        ? C.danger
        : /encrypt|enabled|\bon\b|yes/.test(s)
          ? C.success
          : null;
    case 'protection':
      return null;
    case 'avDefinitionsAgeDays':
      return n == null ? null : n > 30 ? C.danger : n > 14 ? C.warning : C.success;
    case 'pendingPatches':
      return n == null ? null : n > 0 ? C.warning : C.success;
    case 'criticalPatches':
    case 'openVulnCritical':
      return n == null ? null : n > 0 ? C.danger : C.success;
    case 'openVulnHigh':
      return n == null ? null : n > 0 ? C.warning : C.success;
    case 'localAdmins':
      return n == null ? null : n > 2 ? C.warning : null;
    case 'cisPassRate':
      return n == null ? null : n >= 90 ? C.success : n >= 70 ? C.warning : C.danger;
    default:
      return null;
  }
}

function formatPostureCell(key: string, raw: unknown): string {
  if (raw === true) return 'Yes';
  if (raw === false) return 'No';
  if (raw == null) return '—';
  const s = String(raw).trim();
  if (s === '' ) return '—';
  if (s.toLowerCase() === 'no data') return 'No data';
  if (key === 'cisPassRate' && num(raw) != null) return `${num(raw)}%`;
  if (key === 'os') return OS_LABELS[s.toLowerCase()] ?? s;
  return s;
}

type HeadCell = {
  content: string;
  rowSpan?: number;
  colSpan?: number;
  styles?: { halign?: 'left' | 'center'; valign?: 'middle' };
};

/** "Oct 2, 2026" in the report timezone, or null for a missing/invalid timestamp. */
function formatLastSeen(raw: unknown): string | null {
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null;
  return formatReportDate(raw, L);
}

/**
 * Per-device evidence table. With `startY` it starts under a section heading on
 * the current (partly used) page instead of a page of its own (#12043).
 */
function renderPostureTable(doc: jsPDF, rows: Record<string, unknown>[], opts: RenderOpts, startY?: number): void {
  const countLabel = `${rows.length} device${rows.length === 1 ? '' : 's'}`;
  let tableTop: number;
  if (startY == null) {
    doc.addPage();
    drawTitleBlock(doc, 'Per-device detail', '', countLabel, PAGE.bandH + 8);
    tableTop = PAGE.bandH + 16;
  } else {
    tableTop = drawSectionHeading(doc, `Per-device detail \u00b7 ${countLabel}`, startY + 2.5) - 1;
  }

  // Drop the CIS column when no device was assessed — a full column of dashes
  // is noise, and its absence matches the cover's "Not assessed" line.
  const cols = POSTURE_COLUMNS.filter(
    (col) => col.key !== 'cisPassRate' || rows.some((r) => num(r.cisPassRate) != null),
  );
  // Scale fixed widths so the table always fills the content width exactly
  // (aligning its right edge with the page-1 elements), whatever columns are active.
  const contentW = PAGE.w - PAGE.mx * 2;
  const scale = contentW / cols.reduce((a, c) => a + c.w, 0);

  // Two-tier header: ungrouped columns span both rows; "Patches" and
  // "Vulnerabilities" group labels sit above their sub-columns so "Pending" /
  // "Critical" unambiguously read as patch counts.
  const groupOf = (key: string) => POSTURE_COLUMN_GROUPS.find((g) => g.keys.includes(key));
  const headTop: HeadCell[] = [];
  const headSub: HeadCell[] = [];
  for (const col of cols) {
    const group = groupOf(col.key);
    if (!group) {
      headTop.push({ content: col.label, rowSpan: 2, styles: { halign: col.halign, valign: 'middle' } });
    } else {
      if (headTop[headTop.length - 1]?.content !== group.label) {
        headTop.push({
          content: group.label,
          colSpan: cols.filter((c) => group.keys.includes(c.key)).length,
          styles: { halign: 'center' },
        });
      }
      headSub.push({ content: col.label, styles: { halign: 'center' } });
    }
  }
  const head = [headTop, headSub];

  // Two records can share a hostname (a re-enrolment or a stale duplicate);
  // give the reader the last check-in so the rows can be told apart (#12044).
  const hostKey = (row: Record<string, unknown>) => String(row.hostname ?? '').trim().toLowerCase();
  const hostCounts = new Map<string, number>();
  for (const row of rows) hostCounts.set(hostKey(row), (hostCounts.get(hostKey(row)) ?? 0) + 1);
  const body = rows.map((row) => cols.map((col) => {
    const cell = formatPostureCell(col.key, row[col.key]);
    if (col.key !== 'hostname' || (hostCounts.get(hostKey(row)) ?? 0) < 2) return cell;
    // Legacy rows carry no lastSeenAt key at all; a null one never checked in.
    if (!('lastSeenAt' in row)) return cell;
    const seen = formatLastSeen(row.lastSeenAt);
    return `${cell}\n${seen ? `last seen ${seen}` : 'never checked in'}`;
  }));
  const columnStyles: Record<number, { cellWidth: number; halign: 'left' | 'center' }> = {};
  cols.forEach((col, i) => {
    columnStyles[i] = { cellWidth: col.w * scale, halign: col.halign };
  });

  // Totals row: sum the count columns, average CIS, so the evidence table
  // closes with a fleet-level rollup the per-row detail doesn't give.
  const sum = (key: string) => rows.reduce((a, r) => a + (num(r[key]) ?? 0), 0);
  const cisVals = rows.map((r) => num(r.cisPassRate)).filter((n): n is number => n != null);
  const cisAvg = cisVals.length ? Math.round(cisVals.reduce((a, b) => a + b, 0) / cisVals.length) : null;
  const foot = [
    cols.map((col) => {
      switch (col.key) {
        case 'hostname':
          return `Totals · ${rows.length} device${rows.length === 1 ? '' : 's'}`;
        case 'localAdmins': {
          // Summing admin accounts across devices double-counts shared accounts;
          // the honest fleet rollup is the worst single device.
          const counts = rows.map((r) => num(r.localAdmins)).filter((n): n is number => n != null);
          return counts.length ? `max ${Math.max(...counts)}` : '—';
        }
        case 'pendingPatches':
          return String(sum('pendingPatches'));
        case 'criticalPatches':
          return String(sum('criticalPatches'));
        case 'openVulnHigh':
          return String(sum('openVulnHigh'));
        case 'openVulnCritical':
          return String(sum('openVulnCritical'));
        case 'cisPassRate':
          return cisAvg == null ? '—' : `${cisAvg}% avg`;
        default:
          return '';
      }
    }),
  ];

  autoTable(doc, {
    startY: tableTop,
    margin: { top: PAGE.bandH + 6, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
    head,
    body,
    foot,
    showFoot: 'lastPage',
    theme: 'grid',
    rowPageBreak: 'avoid', // never split a device row across pages (orphaned cell fragments)
    styles: { fontSize: 7.5, cellPadding: 1.8, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7.5, lineColor: C.white, lineWidth: 0.15 },
    footStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold', fontSize: 7.5, lineColor: C.rule },
    alternateRowStyles: { fillColor: C.zebra },
    columnStyles,
    didParseCell: (data: CellHookData) => {
      if (data.section === 'body') {
        const col = cols[data.column.index];
        if (!col) return;
        const raw = rows[data.row.index]?.[col.key];
        const color = postureCellColor(col.key, raw);
        if (color) {
          data.cell.styles.textColor = color;
          // Bold at-risk AND needs-attention values so the signal survives
          // grayscale printing, where amber/green/red numerals converge.
          if (color === C.danger || color === C.warning) data.cell.styles.fontStyle = 'bold';
        }
      } else if (data.section === 'foot') {
        const col = cols[data.column.index];
        if (!col) return;
        // Red totals when there are open criticals; amber for pending/high.
        const n = num(data.cell.text.join(''));
        if ((col.key === 'criticalPatches' || col.key === 'openVulnCritical') && (n ?? 0) > 0) {
          data.cell.styles.textColor = C.danger;
        } else if ((col.key === 'pendingPatches' || col.key === 'openVulnHigh') && (n ?? 0) > 0) {
          data.cell.styles.textColor = C.warning;
        }
      }
    },
    didDrawPage: (data) => {
      drawHeaderBand(doc, opts);
      drawFooter(doc, opts);
    },
  });
}

// ----------------------------------------------------------------------------
// Generic report table (any report type): humanized headers + value formatting.
// ----------------------------------------------------------------------------

function formatGenericCell(raw: unknown): string {
  if (raw === true) return 'Yes';
  if (raw === false) return 'No';
  if (raw == null) return '—';
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : '—';
  const s = String(raw).trim();
  if (s === '') return '—';
  // ISO date / datetime → the report's date format (#12048). A bare date is a
  // calendar day and is never shifted into the previous day by the timezone.
  if (/^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(s)) {
    const hasTime = /T\d|\s\d{2}:/.test(s);
    // "2026-11-09 12:30:00+00" (Postgres text) is not ISO once the space
    // becomes a T (the offset lacks minutes), so try it as given too.
    const formatted = hasTime
      ? formatReportDateTime(s.replace(' ', 'T'), L) ?? formatReportDateTime(s, L)
      : formatReportDate(s, L);
    if (formatted) return formatted;
  }
  return s;
}

function renderGenericReport(doc: jsPDF, rows: Record<string, unknown>[], opts: RenderOpts): void {
  const title = reportTypeLabel(opts.reportType);
  drawTitleBlock(doc, title, '', `Generated ${opts.generatedAt}   ·   ${rows.length} record${rows.length === 1 ? '' : 's'}`, PAGE.bandH + 8);

  if (rows.length === 0) {
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text('No data available for the selected filters.', PAGE.mx, PAGE.bandH + 26);
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    return;
  }

  const keys = Object.keys(rows[0]!);
  const head = [keys.map(humanizeHeader)];
  const body = rows.map((row) => keys.map((k) => formatGenericCell(row[k])));

  autoTable(doc, {
    startY: PAGE.bandH + 22,
    margin: { top: PAGE.bandH + 6, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
    head,
    body,
    theme: 'grid',
    rowPageBreak: 'avoid', // never split a record row across pages
    styles: { fontSize: 8, cellPadding: 2, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', lineColor: C.primary },
    alternateRowStyles: { fillColor: C.zebra },
    didParseCell: (data: CellHookData) => {
      if (data.section === 'body' && data.cell.text.join('') === '—') {
        data.cell.styles.textColor = C.faint;
      }
    },
    didDrawPage: (data) => {
      drawHeaderBand(doc, opts);
      drawFooter(doc, opts);
    },
  });
}

/**
 * Build a fully-branded report PDF. The security & compliance posture report
 * leads with a scorecard cover and a curated per-device table; every other
 * report renders a humanized, formatted generic table. Brand chrome (header
 * band + footer) is applied to every page.
 */
export function buildReportPdf(rows: unknown[], opts: BuildOpts): jsPDF {
  // Restores whatever was active before (the defaults, or an enclosing
  // build's state), even when the build throws.
  const locale = resolveReportLocale(opts.branding, opts.timezone);
  const state: BuildState = { C: paletteForBranding(opts.branding), PAGE: reportPageGeometry(locale.pageSize), L: locale };
  return withBuildState(state, () =>
    buildReportPdfWithPalette(rows, { ...opts, generatedAt: generatedAtLabel(opts.generatedAt) }));
}

/** The palette, page geometry and locale one build renders with. */
type BuildState = { C: Palette; PAGE: ReportPageGeometry; L: ReportLocale };

/** Run `fn` with `state` as the module's active build state, then restore
 *  whatever was active before (nothing leaks either way). */
function withBuildState<R>(state: BuildState, fn: () => R): R {
  const prev: BuildState = { C, PAGE, L };
  C = state.C;
  PAGE = state.PAGE;
  L = state.L;
  try {
    return fn();
  } finally {
    C = prev.C;
    PAGE = prev.PAGE;
    L = prev.L;
  }
}

/** `chrome` for one build, bound to the build state active when it is made. */
function boundChrome(opts: RenderOpts) {
  const state: BuildState = { C, PAGE, L };
  const locale = state.L;
  return {
    C: state.C,
    PAGE: state.PAGE,
    drawHeaderBand: (d: jsPDF) => withBuildState(state, () => drawHeaderBand(d, opts)),
    drawFooter: (d: jsPDF) => withBuildState(state, () => drawFooter(d, opts)),
    drawTitleBlock: (...args: Parameters<typeof drawTitleBlock>) => withBuildState(state, () => drawTitleBlock(...args)),
    drawSectionHeading: (...args: Parameters<typeof drawSectionHeading>) => withBuildState(state, () => drawSectionHeading(...args)),
    formatDate: (value: string | Date | null | undefined) => formatReportDate(value, locale),
    formatDateTime: (value: string | Date | null | undefined) => formatReportDateTime(value, locale),
    formatPeriod: (start: string | Date | null | undefined, end: string | Date | null | undefined) =>
      formatReportPeriod(start, end, locale),
    metaSeparator: REPORT_META_SEPARATOR,
  };
}

/** The generation instant as printed: the partner's date format plus the
 *  timezone. A caller-formatted string (not an ISO instant) is kept as given. */
function generatedAtLabel(value: string | Date): string {
  if (value instanceof Date || /^\d{4}-\d{2}-\d{2}T/.test(value)) return fmtDateTime(value, String(value));
  return value;
}

function buildReportPdfWithPalette(rows: unknown[], opts: RenderOpts): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', format: L.pageSize });
  const records = rows as Record<string, unknown>[];
  // Document metadata: the title a reader sees in their viewer tab and the
  // language a screen reader announces. Cheap, and the only structure jsPDF
  // can give an assistive reader.
  const orgName = (opts.summary as { org?: { name?: string } } | undefined)?.org?.name?.trim();
  if (typeof doc.setProperties === 'function') {
    doc.setProperties({
      title: orgName ? `${reportTypeLabel(opts.reportType)} report for ${orgName}` : `${reportTypeLabel(opts.reportType)} report`,
      subject: `${reportTypeLabel(opts.reportType)} report prepared ${opts.generatedAt}`,
      author: opts.branding?.name?.trim() || 'Breeze',
      creator: 'Breeze RMM',
    });
  }
  if (typeof doc.setLanguage === 'function') doc.setLanguage('en-US');

  // The design system every designed sub-renderer draws with. Built once per
  // document so all of them share one page size, palette and date format.
  // Bound to THIS build's palette, page and locale, captured now: the
  // formatters close over them and the drawing helpers re-enter them, so a
  // renderer that kept `chrome` past the build (an async one, say) still
  // prints this partner's settings, never the next build's (#12048 review).
  const chrome = boundChrome(opts);

  // SAFE guard is intentionally asymmetric: a summary carrying an exec shape
  // ('devices' key) must not enter the posture cover, but we don't require any
  // posture-specific key here because legacy posture snapshots are all-optional
  // and must keep rendering.
  if (opts.reportType === 'security_compliance_posture' && opts.summary && !('devices' in (opts.summary as object))) {
    // Aggregate the per-device rows for the scorecard right-rail risk stats.
    const agg: PostureAggregates = records.reduce<PostureAggregates>(
      (acc, r) => {
        acc.criticalPatchCount += num(r.criticalPatches) ?? 0;
        acc.criticalVulnCount += num(r.openVulnCritical) ?? 0;
        // Legacy fallback only (current snapshots carry controls.unprotectedCount):
        // a row counts as unprotected on evidence — no product detected, or
        // real-time protection reported off. A "No data" row is not assessed.
        const prot = typeof r.protection === 'string' ? r.protection.trim().toLowerCase() : '';
        if (r.protectionManaged !== true && (prot === 'none detected' || r.realTimeProtection === false)) {
          acc.unprotectedCount += 1;
        }
        return acc;
      },
      { criticalPatchCount: 0, criticalVulnCount: 0, unprotectedCount: 0 },
    );
    const flow = renderPostureCover(doc, opts.summary as PostureSummary, opts, agg);
    if (records.length > 0 && !flow.onCover && flow.y + POSTURE_TABLE_MIN_SPACE <= flow.bottom) {
      // Share the continuation page; autotable's didDrawPage draws its chrome.
      flow.chromePending = false;
      renderPostureTable(doc, records, opts, flow.y);
    } else {
      finishPosturePage(flow);
      if (records.length > 0) renderPostureTable(doc, records, opts);
    }
  } else if (opts.reportType === 'executive_summary' && opts.summary && 'devices' in (opts.summary as object)) {
    renderExecutiveSummaryCover(doc, opts.summary as ExecutiveSummary, opts);
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
  } else if (
    opts.reportType === 'ai_org_narrative'
    && opts.summary
    && (opts.summary as OrgNarrativeReportSummary).narrative
  ) {
    // Fully self-contained w.r.t. chrome (like the generic/autoTable path
    // below) because a narrative's bullet volume is unbounded up to the
    // schema caps and may paginate; buildReportPdf must not draw a second,
    // conflicting header/footer over whatever page rendering left current.
    renderNarrativeReport(doc, (opts.summary as OrgNarrativeReportSummary).narrative!, opts);
  } else if (
    opts.reportType === 'ai_fleet_design'
    && opts.summary
    && (opts.summary as FleetDesignReportSummary).fleetDesign
  ) {
    // Same self-contained-chrome rationale as the narrative arm above:
    // section/table volume is unbounded up to the schema caps and may
    // paginate on its own.
    renderFleetDesignReport(doc, (opts.summary as FleetDesignReportSummary).fleetDesign!, opts);
  } else if (
    opts.reportType === 'hardware_lifecycle'
    && opts.summary
    && Array.isArray((opts.summary as HardwareLifecycleSummary).rows)
  ) {
    // Self-contained chrome: the plan table paginates on its own (didDrawPage)
    // and the sections after it add pages as needed.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderHardwareLifecycleReport(
      doc,
      opts.summary as HardwareLifecycleSummary,
      { generatedAt: opts.generatedAt, partnerName: opts.branding?.name ?? null, contactEmail: opts.branding?.contactEmail ?? null, contactName: opts.branding?.contactName ?? null },
      chrome,
    );
  } else if (
    opts.reportType === 'backup_status'
    && opts.summary
    && Array.isArray((opts.summary as BackupStatusReportData).rows)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderBackupStatusReport(
      doc,
      opts.summary as BackupStatusReportData,
      { generatedAt: opts.generatedAt, timezone: opts.timezone },
      chrome,
    );
  } else if (
    opts.reportType === 'threat_detection_review'
    && opts.summary
    // `!= null` FIRST: `typeof null === 'object'`, so a summary carrying an
    // explicit `coverage: null` would otherwise enter the arm and render the
    // reassuring "covers the whole of this period" default — worse than
    // falling through to the generic renderer, which at least does not claim
    // coverage it cannot vouch for.
    && (opts.summary as ThreatDetectionSummary).coverage != null
    && typeof (opts.summary as ThreatDetectionSummary).coverage === 'object'
  ) {
    // Self-contained chrome: the detection table paginates on its own
    // (didDrawPage) and the sections after it add pages as needed.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    threatDetectionPdf.renderThreatDetectionReport(
      doc,
      opts.summary as ThreatDetectionSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'endpoint_management_review'
    && opts.summary
    && Array.isArray((opts.summary as EndpointManagementSummary).rows)
  ) {
    // #5784 W03. Self-contained chrome for the same reason as the arm above:
    // the device, trend and licence tables paginate on their own.
    //
    // A type with NO arm here silently falls through to renderGenericReport,
    // which drops the entire designed summary and prints a plain row table —
    // a plausible-looking, wrong PDF on both the portal (renderRunPdf) and the
    // scheduled-email path. reportPdf.endpointManagement.test.ts is what
    // catches that regression.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderEndpointManagementReport(
      doc,
      opts.summary as EndpointManagementSummary,
      { generatedAt: opts.generatedAt, partnerName: opts.branding?.name ?? null },
      chrome,
    );
  } else if (
    opts.reportType === 'vulnerability_management'
    && opts.summary
    && typeof (opts.summary as VulnerabilityManagementSummary).open === 'object'
  ) {
    // #5784 W04. WITHOUT this arm the type falls through to
    // `renderGenericReport` below, which prints the rows as a plain table and
    // silently drops the whole designed summary — the exceptions section
    // included. Self-contained chrome: both tables paginate on their own.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderVulnerabilityManagementReport(
      doc,
      opts.summary as VulnerabilityManagementSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'identity_access_review'
    && opts.summary
    // #5784 W06. `!= null` FIRST, for the same reason as the W02 arm above:
    // `typeof null === 'object'`, so a snapshot carrying an explicit
    // `coverage: null` would otherwise enter the arm and render the reassuring
    // "covers the whole of this period" default. Falling through to the generic
    // renderer at least claims no coverage it cannot vouch for.
    //
    // A type with NO arm here falls through to renderGenericReport, which prints
    // the rows as a plain table and DROPS the whole designed summary. On a
    // PII-bearing identity artifact that is not merely an ugly PDF: the caveats
    // that keep it honest disappear while the sign-in rows remain.
    && (opts.summary as IdentityAccessSummary).coverage != null
    && typeof (opts.summary as IdentityAccessSummary).coverage === 'object'
  ) {
    // Self-contained chrome: the admin sign-in table paginates on its own
    // (didDrawPage) and the sections after it add pages as needed.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    identityAccessPdf.renderIdentityAccessReport(
      doc,
      opts.summary as IdentityAccessSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'ticket_sla_attainment'
    && opts.summary
    // `!= null` FIRST: typeof null === 'object', so a summary carrying an
    // explicit `period: null` must not enter the arm and render a period label
    // it does not have. Same guard shape as the identity_access_review arm above.
    && (opts.summary as TicketSlaSummary).period != null
    && typeof (opts.summary as TicketSlaSummary).period === 'object'
  ) {
    // Self-contained chrome: the group and detail tables paginate on their own.
    // A type with NO arm here silently falls through to renderGenericReport,
    // which prints the rows as a flat table and DROPS the whole designed
    // summary — including the approximation notes that keep this report honest.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    ticketSlaPdf.renderTicketSlaReport(
      doc,
      opts.summary as TicketSlaSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'technician_time_billability'
    && opts.summary
    && (opts.summary as TechnicianTimeSummary).period != null
    && typeof (opts.summary as TechnicianTimeSummary).period === 'object'
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    technicianTimePdf.renderTechnicianTimeReport(
      doc,
      opts.summary as TechnicianTimeSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'ar_aging'
    && opts.summary
    // AR has no period object — it has an as-of date — so the guard checks
    // that shape instead.
    && typeof (opts.summary as ArAgingSummary).asOf === 'string'
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    arAgingPdf.renderArAgingReport(
      doc,
      opts.summary as ArAgingSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'ai_usage_by_client'
    && opts.summary
    // Same guard shape as the SLA / technician arms: `!= null` first
    // (typeof null === 'object'), and `groups` is what separates this summary
    // from the other period-bearing business summaries.
    && (opts.summary as AiUsageByClientSummary).period != null
    && typeof (opts.summary as AiUsageByClientSummary).period === 'object'
    && Array.isArray((opts.summary as AiUsageByClientSummary).groups)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    aiUsageByClientPdf.renderAiUsageByClientReport(
      doc,
      opts.summary as AiUsageByClientSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'mrr_renewals'
    && opts.summary
    && typeof (opts.summary as MrrRenewalsSummary).asOf === 'string'
    && Array.isArray((opts.summary as MrrRenewalsSummary).byCurrency)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    mrrRenewalsPdf.renderMrrRenewalsReport(
      doc,
      opts.summary as MrrRenewalsSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'quote_win_rate'
    && opts.summary
    && (opts.summary as QuoteWinRateSummary).overall != null
    && typeof (opts.summary as QuoteWinRateSummary).overall === 'object'
    && (opts.summary as QuoteWinRateSummary).period != null
    && Array.isArray((opts.summary as QuoteWinRateSummary).groups)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    quoteWinRatePdf.renderQuoteWinRateReport(
      doc,
      opts.summary as QuoteWinRateSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      chrome,
    );
  } else if (
    opts.reportType === 'client_profitability'
    && opts.summary
    && Array.isArray((opts.summary as ClientProfitabilitySummary).byCurrency)
    && Array.isArray((opts.summary as ClientProfitabilitySummary).orgs)
    && Array.isArray((opts.summary as ClientProfitabilitySummary).sources)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    clientProfitabilityPdf.renderClientProfitabilityReport(
      doc,
      opts.summary as ClientProfitabilitySummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
      },
      chrome,
    );
  } else if (opts.reportType === 'ticket_sla_performance' && isTicketSlaPerformanceSummary(opts.summary)) {
    // Self-contained chrome: both tables paginate on their own.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    ticketSlaPerformancePdf.renderTicketSlaPerformanceReport(
      doc,
      opts.summary,
      { generatedAt: opts.generatedAt },
      chrome,
    );
  } else {
    if (DESIGNED_BUSINESS_TYPES.has(opts.reportType)) {
      const reason = opts.summary ? 'summary_shape_mismatch' : 'summary_missing';
      console.warn('[reportPdf] Designed renderer skipped; falling back to the generic table', {
        reportType: opts.reportType,
        reason,
      });
      opts.onRendererFallback?.({ reportType: opts.reportType, reason });
    }
    renderGenericReport(doc, records, opts);
  }

  if (typeof doc.putTotalPages === 'function') {
    doc.putTotalPages(TOTAL_TOKEN);
  }
  return doc;
}
