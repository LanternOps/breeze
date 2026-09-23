import { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';
import type { PostureControls, PostureProduct, PostureSummary } from '../types/postureReport';
import type { ExecutiveSummary } from '../types/executiveSummaryReport';
import type { HardwareLifecycleSummary } from '../types/hardwareLifecycleReport';
import { renderHardwareLifecycleReport } from './hardwareLifecyclePdf';
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
import * as technicianTimePdf from './technicianTimePdf';
import * as arAgingPdf from './arAgingPdf';
import type { TicketSlaSummary, TechnicianTimeSummary, ArAgingSummary } from '../types/businessReports';
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
};

export type BuildOpts = {
  reportType: string;
  /** Already-formatted, timezone-correct generation timestamp. */
  generatedAt: string;
  /** IANA timezone for formatting ISO date cells in generic tables. */
  timezone: string;
  summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary | HardwareLifecycleSummary | ThreatDetectionSummary | EndpointManagementSummary | VulnerabilityManagementSummary | IdentityAccessSummary
    | TicketSlaSummary | TechnicianTimeSummary | ArAgingSummary;
  /** Slim baseline from the previous completed run, when the caller supplied
   * one (report_runs.result.previous) — drives the scorecard trend chip and
   * its "since <date>" label. */
  previous?: { generatedAt?: string | null; summary?: unknown };
  branding?: ReportBranding;
};

const PAGE = { w: 297, h: 210, mx: 14, bandH: 19, footY: 199 } as const;
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
  threat_detection_review: 'Threat Detection Review',
  endpoint_management_review: 'Endpoint Management Review',
  vulnerability_management: 'Vulnerability Management',
  ticket_sla_attainment: 'Ticket SLA Attainment',
  technician_time_billability: 'Technician Time & Billability',
  ar_aging: 'AR Aging',
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

function drawHeaderBand(doc: jsPDF, opts: BuildOpts): void {
  const { branding, reportType } = opts;
  set.fill(doc, C.primary);
  doc.rect(0, 0, PAGE.w, PAGE.bandH, 'F');
  // Teal brand ribbon under the band.
  set.fill(doc, C.teal);
  doc.rect(0, PAGE.bandH, PAGE.w, 0.7, 'F');

  const name = branding?.name?.trim() || 'Breeze';
  const yMid = PAGE.bandH / 2;

  // Partner logo when uploaded (carries its own wordmark); otherwise the Breeze
  // vector mark + partner/Breeze name. A failed embed degrades to the mark+name.
  let drewLogo = false;
  if (branding?.logoDataUrl) {
    // Fit the logo inside a 9 mm × 60 mm box, preserving its aspect: a tall
    // mark fills the height, a wide wordmark fills the width and shrinks.
    const maxH = 9;
    const maxW = 60;
    const aspect = branding.logoAspect && branding.logoAspect > 0 ? branding.logoAspect : 3;
    const scale = Math.min(maxH, maxW / aspect) / maxH;
    const logoH = maxH * scale;
    const logoW = logoH * aspect;
    const pad = 2;
    const chipW = logoW + pad * 2;
    const chipH = maxH + pad * 2;
    const chipY = yMid - chipH / 2;
    // White safe-area chip so a dark or transparent partner logo always reads on
    // the brand-colour band (letterhead convention).
    set.fill(doc, C.white);
    doc.roundedRect(PAGE.mx, chipY, chipW, chipH, 1.6, 1.6, 'F');
    try {
      doc.addImage(branding.logoDataUrl, 'PNG', PAGE.mx + pad, chipY + pad + (maxH - logoH) / 2, logoW, logoH, undefined, 'FAST');
      drewLogo = true;
    } catch {
      // Erase the empty chip and fall back to the Breeze mark + name.
      set.fill(doc, C.primary);
      doc.rect(0, 0, PAGE.mx + chipW + 2, PAGE.bandH, 'F');
      drewLogo = false;
    }
  }
  if (!drewLogo) {
    // Partner-branded but no usable logo: the partner's name IS the letterhead —
    // pairing it with the Breeze mark would brand the deliverable with the
    // tooling instead of the MSP. The Breeze mark appears only when there is no
    // partner context at all.
    const isPartnerBranded = Boolean(branding?.name?.trim());
    let textX = PAGE.mx;
    if (!isPartnerBranded) {
      drawBreezeMark(doc, PAGE.mx, yMid);
      textX = PAGE.mx + 12;
    }
    set.text(doc, C.white);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(name, textX, yMid + 0.2, { baseline: 'middle' });
  }

  // Right side: document category label.
  set.text(doc, C.bandText);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(reportTypeLabel(reportType).toUpperCase(), PAGE.w - PAGE.mx, yMid + 1, {
    align: 'right',
    baseline: 'middle',
  });
}

function drawFooter(doc: jsPDF, opts: BuildOpts): void {
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

function scoreBand(score: number): { label: string; color: RGB } {
  if (score >= 80) return { label: 'STRONG', color: C.success };
  if (score >= 60) return { label: 'GOOD', color: C.primary };
  if (score >= 40) return { label: 'FAIR', color: C.warning };
  return { label: 'AT RISK', color: C.danger };
}

type ScoreStat = { label: string; value: string; tone: RGB };

function drawScorecard(
  doc: jsPDF,
  score: number,
  caption: string,
  stats: ScoreStat[],
  top: number,
  trend?: { delta: number; sinceLabel: string } | null,
): number {
  const x = PAGE.mx;
  const w = PAGE.w - PAGE.mx * 2; // full content width — no dead right half
  const h = 32;
  const band = scoreBand(score);

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
  const meterX = x + 74;
  const meterW = 88;
  const meterY = top + 15;
  if (caption) {
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(caption, meterX, top + 9);
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
    const railX = x + w - 92;
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
      doc.text(st.label, cx, top + 23, { align: 'center' });
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
function trendFor(opts: BuildOpts, current: number | null | undefined, pick: (s: Record<string, unknown>) => unknown): { delta: number; sinceLabel: string } | null {
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
    [null, 'Informational'], // hollow ring — matches neutral metric dots
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
function pctStatus(v: number | null | undefined, good = 90, warn = 60): MetricStatus {
  if (v == null) return 'na';
  if (v >= good) return 'good';
  if (v >= warn) return 'warn';
  return 'bad';
}

export function buildPostureBackupMetric(controls: PostureControls) {
  const backupRequired = controls.backupRequired !== false;
  const backupValue = backupRequired
    ? `${yesNo(controls.backupConfigured)}${controls.backupConfigured && controls.backupEncrypted ? ' (encrypted)' : ''}`
    : controls.backupConfigured
      ? 'Optional; configured'
      : 'Not required';
  return {
    label: 'Backup',
    value: backupValue,
    status: backupRequired ? boolStatus(controls.backupConfigured) : 'neutral',
  } satisfies Metric;
}

type PostureAggregates = { criticalCount: number; unprotectedCount: number };

function renderPostureCover(
  doc: jsPDF,
  summary: PostureSummary,
  opts: BuildOpts,
  agg: PostureAggregates,
): PostureProduct[] {
  const c = summary.controls ?? {};
  const p = summary.privilegedAccess ?? {};
  const deviceCount = summary.deviceCount ?? 0;

  let y = drawTitleBlock(
    doc,
    'Security & Compliance Posture',
    summary.org?.name ?? '',
    `Generated ${opts.generatedAt}   ·   ${deviceCount} device${deviceCount === 1 ? '' : 's'} assessed`,
    PAGE.bandH + 8,
  );

  if (summary.postureScore != null) {
    // The meter must be captioned with what it plots (the composite score) —
    // captioning it with the AV-coverage % made the bar read as coverage.
    const caption = 'Overall posture score across assessed controls';
    const unprotected = c.unprotectedCount ?? agg.unprotectedCount;
    const protectedCount = Math.max(0, deviceCount - unprotected);
    const stats: ScoreStat[] = [
      { label: 'AV protected', value: `${protectedCount}/${deviceCount}`, tone: unprotected > 0 ? C.warning : C.success },
      { label: 'Critical patches/vulns', value: String(agg.criticalCount), tone: agg.criticalCount > 0 ? C.danger : C.success },
      { label: 'Unprotected', value: String(unprotected), tone: unprotected > 0 ? C.danger : C.success },
    ];
    y = drawScorecard(
      doc,
      summary.postureScore,
      caption,
      stats,
      y,
      trendFor(opts, summary.postureScore, (s) => (s as { postureScore?: unknown }).postureScore),
    );
    // Methodology in one muted line, so "79 — GOOD" is auditable rather than oracular.
    set.text(doc, C.faint);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(
      'Score: weighted per-device security factors — patching 25%, encryption 15%, AV health 15%, firewall / open ports / password policy / OS currency 10% each, admin exposure 5% — averaged across assessed devices.',
      PAGE.mx,
      y - 2.5,
    );
    y += 1.5;
  }

  const ccHeadingY = y + 2;
  y = drawSectionHeading(doc, 'Control coverage', ccHeadingY);
  drawLegend(doc, ccHeadingY); // color key, right-aligned to the heading
  // Left column: device protection & hygiene. Right column: access, identity
  // & network. The grid fills column-major, so array order = reading order.
  const protectionMetrics: Metric[] = [
    { label: 'Managed EDR coverage', value: pctStr(c.edrCoveragePct), status: pctStatus(c.edrCoveragePct), target: '>=90%' },
    { label: 'AV + real-time protection', value: pctStr(c.anyAvCoveragePct), status: pctStatus(c.anyAvCoveragePct), target: '>=95%' },
    {
      label: 'Unprotected devices',
      value: String(c.unprotectedCount ?? 0),
      status: (c.unprotectedCount ?? 0) > 0 ? 'bad' : 'good',
      target: 'none', // "0" beside a value of 0 read as a duplicated numeral
    },
    { label: 'AV definitions current', value: pctStr(c.avDefinitionsCurrentPct), status: pctStatus(c.avDefinitionsCurrentPct), target: '>=95%' },
    { label: 'Disk encryption', value: pctStr(c.encryptionPct), status: pctStatus(c.encryptionPct), target: '>=90%' },
    { label: 'Patch current (no critical pending)', value: pctStr(c.patchCurrentPct), status: pctStatus(c.patchCurrentPct, 90, 70), target: '>=90%' },
  ];
  if (c.cisIncluded !== false) {
    const cisVal =
      c.cisAvgPassRate == null
        ? 'Not assessed'
        : `${c.cisAvgPassRate}% (${c.cisAssessedCount ?? 0}/${deviceCount})`;
    protectionMetrics.push({ label: 'CIS hardening', value: cisVal, status: pctStatus(c.cisAvgPassRate, 90, 70), target: '>=90%' });
  }
  const backupMetric = buildPostureBackupMetric(c);
  const accessMetrics: Metric[] = [
    { label: 'Host firewall', value: pctStr(c.firewallPct), status: pctStatus(c.firewallPct), target: '>=95%' },
    { label: 'Password complexity', value: pctStr(c.passwordComplexityPct), status: pctStatus(c.passwordComplexityPct), target: '>=90%' },
    { label: 'Local-admin exposure', value: pctStr(c.localAdminExposurePct), status: pctStatus(c.localAdminExposurePct == null ? null : 100 - c.localAdminExposurePct), target: '<=10%' },
    { label: 'Identity provider connected', value: yesNo(c.identityProviderConnected), status: boolStatus(c.identityProviderConnected) },
    backupMetric,
    { label: 'DNS filtering active', value: yesNo(c.dnsFilteringActive), status: boolStatus(c.dnsFilteringActive) },
  ];
  y = drawMetricGrid(doc, [...protectionMetrics, ...accessMetrics], y);

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

  // Recommendations come before the product inventory: the reader's next step
  // matters more than the tooling list. Reserve one product line of space so
  // the inventory is never squeezed off the page entirely.
  const products = summary.securityProducts ?? [];
  const productReserve = products.length > 0 ? 13.5 : 0;
  y = drawRecommendedActions(doc, summary, agg, y + 2.5, productReserve);

  let overflow: PostureProduct[] = [];
  if (products.length > 0) {
    y = drawSectionHeading(doc, 'Security products in use', y + 2.5);
    const bottomY = PAGE.footY - 9;
    const fullCapacity = Math.max(0, Math.floor((bottomY - y) / POSTURE_PRODUCT_ROW_HEIGHT) + 1);
    const needsContinuation = products.length > fullCapacity;
    // When products overflow, leave a full line below the rendered rows for
    // the explicit continuation notice instead of silently clipping a name.
    const coverCapacity = needsContinuation
      ? Math.max(0, Math.floor((bottomY - POSTURE_PRODUCT_CONTINUATION_SPACE - y) / POSTURE_PRODUCT_ROW_HEIGHT))
      : products.length;
    const coverProducts = products.slice(0, coverCapacity);
    for (const product of coverProducts) {
      y = drawPostureProductRow(doc, product, y);
    }
    overflow = products.slice(coverProducts.length);
    if (overflow.length > 0) {
      set.text(doc, C.muted);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(
        `+ ${overflow.length} product${overflow.length === 1 ? '' : 's'} continued on the next page`,
        PAGE.mx + 5,
        y,
      );
    }
  }

  // Plain-language key for the acronyms a non-technical client will hit above,
  // pinned just over the footer rule.
  set.text(doc, C.faint);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(
    'EDR: endpoint detection & response   ·   AV: antivirus   ·   MFA: multi-factor authentication   ·   UAC: Windows admin-consent prompting   ·   PAM: privileged access management   ·   CIS: Center for Internet Security benchmark',
    PAGE.mx,
    PAGE.footY - 2,
  );
  return overflow;
}

// ----------------------------------------------------------------------------
// Recommended actions: plain-language next steps derived from failing controls.
// Bridges the gap between "score 79 GOOD" and the red rows beneath it — the
// reader leaves with a plan instead of a contradiction.
// ----------------------------------------------------------------------------

type Recommendation = { severity: 'bad' | 'warn'; text: string };

function buildRecommendations(summary: PostureSummary, agg: PostureAggregates): Recommendation[] {
  const c = summary.controls ?? {};
  const p = summary.privilegedAccess ?? {};
  const recs: Recommendation[] = [];
  const unprotected = c.unprotectedCount ?? agg.unprotectedCount;
  if (unprotected > 0) {
    recs.push({ severity: 'bad', text: `Deploy protection to the ${unprotected} unprotected device${unprotected === 1 ? '' : 's'} — these are the fleet's most exposed endpoints.` });
  }
  if (agg.criticalCount > 0) {
    recs.push({ severity: 'bad', text: `Remediate ${agg.criticalCount} critical patch/vulnerability finding${agg.criticalCount === 1 ? '' : 's'} (see per-device detail).` });
  }
  if (c.backupRequired !== false && c.backupConfigured === false) {
    recs.push({ severity: 'bad', text: 'Configure backups — no backup solution is currently detected for this organization.' });
  }
  if (p.mfaStepUpEnforced === false) {
    recs.push({ severity: 'bad', text: 'Enforce MFA step-up so privileged actions require a second factor.' });
  }
  if (c.localAdminExposurePct != null && c.localAdminExposurePct > 10) {
    recs.push({ severity: 'bad', text: `Reduce local administrator rights — ${c.localAdminExposurePct}% of devices exceed the 10% exposure target.` });
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
    recs.push({ severity: 'warn', text: `Extend managed EDR coverage (currently ${c.edrCoveragePct}%, target 90%).` });
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
  if (p.uacInterceptionEnabled === false) {
    recs.push({ severity: 'warn', text: 'Enable UAC interception so admin elevations are governed and auditable.' });
  }
  return [...recs.filter((r) => r.severity === 'bad'), ...recs.filter((r) => r.severity === 'warn')];
}

/**
 * Numbered, priority-ordered next steps; renders only what fits above the
 * glossary/footer. Returns the y after the drawn content (or `top` if skipped).
 */
function drawRecommendedActions(
  doc: jsPDF,
  summary: PostureSummary,
  agg: PostureAggregates,
  top: number,
  reservedBelow = 0,
): number {
  const all = buildRecommendations(summary, agg);
  if (all.length === 0) return top;
  const rowH = 5.2;
  // Keep clear of the glossary line above the footer, plus any space the
  // caller has reserved for content that must follow this section.
  const maxY = PAGE.footY - 9 - reservedBelow;
  if (top + 5 + rowH > maxY) return top; // no room for even one item — skip cleanly
  const fit = Math.min(all.length, 5, Math.floor((maxY - top - 5) / rowH));
  let y = drawSectionHeading(doc, 'Recommended actions', top);
  const recs = all.slice(0, fit);
  doc.setFontSize(9);
  recs.forEach((rec, i) => {
    set.text(doc, rec.severity === 'bad' ? C.danger : C.warning);
    doc.setFont('helvetica', 'bold');
    doc.text(`${i + 1}.`, PAGE.mx + 1, y);
    set.text(doc, C.ink);
    doc.setFont('helvetica', 'normal');
    doc.text(rec.text, PAGE.mx + 6.5, y);
    y += rowH;
  });
  if (all.length > recs.length) {
    set.text(doc, C.muted);
    doc.setFontSize(7.5);
    doc.text(`+ ${all.length - recs.length} further recommendation${all.length - recs.length === 1 ? '' : 's'} available in Breeze`, PAGE.mx + 6.5, y);
    y += 4;
  }
  return y;
}

// ----------------------------------------------------------------------------
// Executive summary cover: the QBR artifact. Same designed skeleton as the
// posture cover — fleet-health scorecard, thematic metric grids, recommended
// actions — driven by the ExecutiveSummary snapshot instead of posture data.
// ----------------------------------------------------------------------------

function buildExecRecommendations(summary: ExecutiveSummary): Recommendation[] {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const recs: Recommendation[] = [];
  if ((d.offline ?? 0) > 0) {
    recs.push({ severity: 'bad', text: `Investigate ${d.offline} offline device${d.offline === 1 ? '' : 's'} — offline endpoints are unmonitored and unpatched.` });
  }
  if ((a.critical ?? 0) > 0) {
    // The snapshot's `resolved` count spans all severities, so we can't claim
    // anything about *critical* resolution status — just flag the criticals.
    recs.push({ severity: 'bad', text: `Triage the ${a.critical} critical alert${a.critical === 1 ? '' : 's'} raised in this reporting window.` });
  }
  if (a.resolutionRate != null && a.resolutionRate < 80 && (a.total ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Raise the alert resolution rate — ${a.resolutionRate}% of alerts were resolved against an 80% target.` });
  }
  if (d.healthPercentage != null && d.healthPercentage < 90 && (d.total ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Restore fleet health to 90%+ — ${d.healthPercentage}% of devices are currently online.` });
  }
  if ((a.high ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Review ${a.high} high-severity alert${a.high === 1 ? '' : 's'} for recurring patterns worth automating away.` });
  }
  return [...recs.filter((r) => r.severity === 'bad'), ...recs.filter((r) => r.severity === 'warn')];
}

function renderExecutiveSummaryCover(doc: jsPDF, summary: ExecutiveSummary, opts: BuildOpts): void {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const total = d.total ?? 0;

  let y = drawTitleBlock(
    doc,
    'Executive Summary',
    summary.org?.name ?? '',
    `Generated ${opts.generatedAt}   ·   ${total} managed device${total === 1 ? '' : 's'}`,
    PAGE.bandH + 8,
  );

  if (d.healthPercentage != null) {
    const offline = d.offline ?? 0;
    const stats: ScoreStat[] = [
      { label: 'Devices online', value: `${d.online ?? 0}/${total}`, tone: offline > 0 ? C.warning : C.success },
      { label: 'Critical alerts', value: String(a.critical ?? 0), tone: (a.critical ?? 0) > 0 ? C.danger : C.success },
      { label: 'Alerts resolved', value: a.resolutionRate == null ? 'N/A' : `${a.resolutionRate}%`, tone: (a.resolutionRate ?? 100) >= 80 ? C.success : C.warning },
    ];
    y = drawScorecard(
      doc,
      d.healthPercentage,
      'Fleet health — share of managed devices online',
      stats,
      y,
      trendFor(opts, d.healthPercentage, (s) => ((s as { devices?: { healthPercentage?: unknown } }).devices ?? {}).healthPercentage),
    );
    set.text(doc, C.faint);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(
      'Fleet health: percentage of managed devices reporting online. Alert figures cover the configured reporting window.',
      PAGE.mx,
      y - 2.5,
    );
    y += 1.5;
  }

  const overviewHeadingY = y + 2;
  y = drawSectionHeading(doc, 'Fleet & alert overview', overviewHeadingY);
  drawLegend(doc, overviewHeadingY);
  // Left column: device availability. Right column: alert activity.
  // Column-major fill, so array order = reading order per column.
  const deviceMetrics: Metric[] = [
    { label: 'Managed devices', value: String(total), status: 'neutral' },
    { label: 'Online now', value: String(d.online ?? 0), status: pctStatus(d.healthPercentage) },
    { label: 'Offline', value: String(d.offline ?? 0), status: (d.offline ?? 0) > 0 ? 'warn' : 'good', target: 'none' },
    { label: 'Fleet health', value: d.healthPercentage == null ? 'N/A' : `${d.healthPercentage}%`, status: pctStatus(d.healthPercentage), target: '>=90%' },
  ];
  const alertMetrics: Metric[] = [
    { label: 'Alerts in window', value: String(a.total ?? 0), status: 'neutral' },
    { label: 'Critical', value: String(a.critical ?? 0), status: (a.critical ?? 0) > 0 ? 'bad' : 'good', target: 'none' },
    { label: 'High severity', value: String(a.high ?? 0), status: (a.high ?? 0) > 0 ? 'warn' : 'good', target: 'none' },
    { label: 'Resolution rate', value: a.resolutionRate == null ? 'N/A' : `${a.resolutionRate}%`, status: pctStatus(a.resolutionRate, 80, 50), target: '>=80%' },
  ];
  y = drawMetricGrid(doc, [...deviceMetrics, ...alertMetrics], y);

  // OS + site composition, side by side via the same two-column grid: left
  // column = OS distribution, right column = largest sites. Pad the shorter
  // list so column-major fill keeps each theme in its own column.
  const osEntries = Object.entries(summary.osDistribution ?? {});
  const sites = summary.siteBreakdown ?? [];
  if (osEntries.length > 0 || sites.length > 0) {
    y = drawSectionHeading(doc, 'Fleet composition', y + 2.5);
    const MAX_COMPOSITION_ROWS = 5;
    const osMetrics: Metric[] = osEntries
      .sort(([, x], [, z]) => z - x)
      .slice(0, MAX_COMPOSITION_ROWS)
      .map(([os, count]) => ({
        label: OS_LABELS[os.toLowerCase()] ?? titleCase(os),
        value: `${count} device${count === 1 ? '' : 's'}`,
        status: 'neutral' as MetricStatus,
      }));
    const shownSites = sites.slice(0, MAX_COMPOSITION_ROWS);
    const siteMetrics: Metric[] = shownSites.map((s) => ({
      label: s.site,
      value: `${s.count} device${s.count === 1 ? '' : 's'}`,
      status: 'neutral' as MetricStatus,
    }));
    if (sites.length > MAX_COMPOSITION_ROWS) {
      const rest = sites.slice(MAX_COMPOSITION_ROWS).reduce((acc, s) => acc + s.count, 0);
      siteMetrics[MAX_COMPOSITION_ROWS - 1] = {
        label: `${shownSites[MAX_COMPOSITION_ROWS - 1]!.site} + ${sites.length - MAX_COMPOSITION_ROWS} more`,
        value: `${(shownSites[MAX_COMPOSITION_ROWS - 1]!.count) + rest} devices`,
        status: 'neutral',
      };
    }
    const rows = Math.max(osMetrics.length, siteMetrics.length);
    const pad = (arr: Metric[]): Metric[] =>
      arr.concat(Array.from({ length: rows - arr.length }, () => ({ label: '', value: '', status: 'na' as MetricStatus })));
    y = drawMetricGrid(doc, [...pad(osMetrics), ...pad(siteMetrics)], y);
  }

  // Recommended actions close the page — the reader leaves with next steps.
  const recs = buildExecRecommendations(summary);
  if (recs.length > 0) {
    const rowH = 5.2;
    const maxY = PAGE.footY - 4;
    if (y + 5 + rowH <= maxY) {
      const fit = Math.min(recs.length, 5, Math.floor((maxY - y - 5) / rowH));
      y = drawSectionHeading(doc, 'Recommended actions', y + 2.5);
      doc.setFontSize(9);
      recs.slice(0, fit).forEach((rec, i) => {
        set.text(doc, rec.severity === 'bad' ? C.danger : C.warning);
        doc.setFont('helvetica', 'bold');
        doc.text(`${i + 1}.`, PAGE.mx + 1, y);
        set.text(doc, C.ink);
        doc.setFont('helvetica', 'normal');
        doc.text(rec.text, PAGE.mx + 6.5, y);
        y += rowH;
      });
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
const NARRATIVE_CONTENT_BOTTOM = PAGE.footY - 8; // keep clear of the footnote line above the footer rule
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

function formatNarrativeIsoDate(iso: unknown, timezone: string): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

function narrativePeriodLabel(narrative: NarrativeSnapshot, timezone: string): string {
  const start = formatNarrativeIsoDate(narrative.periodStart, timezone);
  const end = formatNarrativeIsoDate(narrative.periodEnd, timezone);
  if (start && end) return `${start} - ${end}`;
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
function narrativePageBreak(doc: jsPDF, opts: BuildOpts): number {
  drawHeaderBand(doc, opts);
  drawFooter(doc, opts);
  drawNarrativeFootnote(doc);
  doc.addPage();
  return PAGE.bandH + 10;
}

/** Page-break-aware vertical budget check: rolls onto a fresh page (with chrome
 * drawn on the outgoing one) when `neededH` would run into the footer zone. */
function ensureNarrativeRoom(doc: jsPDF, opts: BuildOpts, y: number, neededH: number): number {
  return y + neededH > NARRATIVE_CONTENT_BOTTOM ? narrativePageBreak(doc, opts) : y;
}

function renderNarrativeReport(doc: jsPDF, narrative: NarrativeSnapshot, opts: BuildOpts): void {
  const orgName = sanitizeNarrativeText(narrative.orgName, NARRATIVE_NAME_MAX_CHARS);
  const agentName = sanitizeNarrativeText(narrative.agentName, NARRATIVE_NAME_MAX_CHARS);
  const period = narrativePeriodLabel(narrative, opts.timezone);

  const metaParts = [`Generated ${opts.generatedAt}`];
  if (period) metaParts.push(period);
  if (agentName) metaParts.push(`Agent: ${agentName}`);

  let y = drawTitleBlock(doc, 'Weekly AI Operations Narrative', orgName, metaParts.join('   ·   '), PAGE.bandH + 8);

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
function fleetDesignPageBreak(doc: jsPDF, opts: BuildOpts): number {
  drawHeaderBand(doc, opts);
  drawFooter(doc, opts);
  drawFleetDesignFootnote(doc);
  doc.addPage();
  return PAGE.bandH + 10;
}

/** Page-break-aware vertical budget check, mirroring `ensureNarrativeRoom` but
 * with the Fleet Design footnote drawn on the outgoing page. */
function ensureFleetDesignRoom(doc: jsPDF, opts: BuildOpts, y: number, neededH: number): number {
  return y + neededH > NARRATIVE_CONTENT_BOTTOM ? fleetDesignPageBreak(doc, opts) : y;
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
function drawFleetDesignBullets(doc: jsPDF, opts: BuildOpts, lines: string[], y: number): number {
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
function drawFleetDesignTable(doc: jsPDF, opts: BuildOpts, head: string[][], body: string[][], y: number): number {
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

function drawFleetDesignFunctionsTable(doc: jsPDF, opts: BuildOpts, functions: unknown, y: number): number {
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

function drawFleetDesignMonitoringSection(doc: jsPDF, opts: BuildOpts, monitoring: unknown, y: number): number {
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

function drawFleetDesignRetiredTable(doc: jsPDF, opts: BuildOpts, retired: unknown, y: number): number {
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

function drawFleetDesignLegacyTable(doc: jsPDF, opts: BuildOpts, legacy: unknown, y: number): number {
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
function drawFleetDesignDriftSection(doc: jsPDF, opts: BuildOpts, drift: unknown, y: number): number {
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

function renderFleetDesignReport(doc: jsPDF, fd: FleetDesignSnapshot, opts: BuildOpts): void {
  const orgName = fdText(fd.orgName, NARRATIVE_NAME_MAX_CHARS);
  const agentName = fdText(fd.agentName, NARRATIVE_NAME_MAX_CHARS);
  const siteName = fdText(fd.siteName, NARRATIVE_NAME_MAX_CHARS);

  const metaParts = [`Generated ${opts.generatedAt}`];
  if (agentName) metaParts.push(`Agent: ${agentName}`);
  if (siteName) metaParts.push(`Site: ${siteName}`);

  let y = drawTitleBlock(doc, 'Fleet Design', orgName, metaParts.join('   ·   '), PAGE.bandH + 8);

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
  // are actually protecting (native AV with real-time protection on), spell that
  // out so one RTP-on device can't imply full-fleet coverage (issue #2517).
  const activeCount = product.activeDeviceCoverage;
  const rtpNote =
    product.deviceCoverage != null && activeCount != null && activeCount < product.deviceCoverage
      ? `, ${activeCount} with real-time protection on`
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

function renderPostureProductContinuation(
  doc: jsPDF,
  products: PostureProduct[],
  opts: BuildOpts,
): void {
  let remaining = [...products];
  while (remaining.length > 0) {
    doc.addPage('a4', 'landscape');
    let y = drawTitleBlock(
      doc,
      'Security products in use',
      '',
      'Continued from the posture summary',
      PAGE.bandH + 8,
    );
    const rowsPerPage = Math.max(
      1,
      Math.floor((PAGE.footY - 12 - y) / POSTURE_PRODUCT_ROW_HEIGHT),
    );
    const pageProducts = remaining.slice(0, rowsPerPage);
    for (const product of pageProducts) {
      y = drawPostureProductRow(doc, product, y);
    }
    remaining = remaining.slice(pageProducts.length);
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
  }
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

function renderPostureTable(doc: jsPDF, rows: Record<string, unknown>[], opts: BuildOpts): void {
  doc.addPage();
  drawTitleBlock(doc, 'Per-device detail', '', `${rows.length} device${rows.length === 1 ? '' : 's'}`, PAGE.bandH + 8);

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

  const body = rows.map((row) => cols.map((col) => formatPostureCell(col.key, row[col.key])));
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
    startY: PAGE.bandH + 16,
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

function formatGenericCell(raw: unknown, timezone: string): string {
  if (raw === true) return 'Yes';
  if (raw === false) return 'No';
  if (raw == null) return '—';
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : '—';
  const s = String(raw).trim();
  if (s === '') return '—';
  // ISO date / datetime → friendly localized form.
  if (/^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const hasTime = /T\d|\s\d{2}:/.test(s);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}),
      }).format(d);
    }
  }
  return s;
}

function renderGenericReport(doc: jsPDF, rows: Record<string, unknown>[], opts: BuildOpts): void {
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
  const body = rows.map((row) => keys.map((k) => formatGenericCell(row[k], opts.timezone)));

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
  C = paletteForBranding(opts.branding);
  try {
    return buildReportPdfWithPalette(rows, opts);
  } finally {
    C = BASE_C;
  }
}

function buildReportPdfWithPalette(rows: unknown[], opts: BuildOpts): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape' });
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

  // SAFE guard is intentionally asymmetric: a summary carrying an exec shape
  // ('devices' key) must not enter the posture cover, but we don't require any
  // posture-specific key here because legacy posture snapshots are all-optional
  // and must keep rendering.
  if (opts.reportType === 'security_compliance_posture' && opts.summary && !('devices' in (opts.summary as object))) {
    // Aggregate the per-device rows for the scorecard right-rail risk stats.
    const agg: PostureAggregates = records.reduce<PostureAggregates>(
      (acc, r) => {
        const crit = (num(r.criticalPatches) ?? 0) + (num(r.openVulnCritical) ?? 0);
        acc.criticalCount += crit;
        const prot = typeof r.protection === 'string' ? r.protection.trim().toLowerCase() : '';
        if (r.protectionManaged === false && (prot === '' || prot === 'no data')) {
          acc.unprotectedCount += 1;
        }
        return acc;
      },
      { criticalCount: 0, unprotectedCount: 0 },
    );
    const overflowProducts = renderPostureCover(doc, opts.summary as PostureSummary, opts, agg);
    // Draw chrome on the cover page (no autotable runs on it).
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderPostureProductContinuation(doc, overflowProducts, opts);
    if (records.length > 0) {
      renderPostureTable(doc, records, opts);
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
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
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
    );
  } else {
    renderGenericReport(doc, records, opts);
  }

  if (typeof doc.putTotalPages === 'function') {
    doc.putTotalPages(TOTAL_TOKEN);
  }
  return doc;
}
