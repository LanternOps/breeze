import { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';
import type { PostureControls, PostureProduct, PostureSummary } from '../types/postureReport';
import type { ExecutiveSummary } from '../types/executiveSummaryReport';

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
const C = {
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

export type ReportBranding = {
  /** Partner display name; falls back to "Breeze" when null. */
  name: string | null;
  /** Partner logo as a raster data URL (PNG/JPEG). Null → vector Breeze mark. */
  logoDataUrl: string | null;
  /** Logo intrinsic aspect ratio (width / height); used to size without distortion. */
  logoAspect: number | null;
};

export type BuildOpts = {
  reportType: string;
  /** Already-formatted, timezone-correct generation timestamp. */
  generatedAt: string;
  /** IANA timezone for formatting ISO date cells in generic tables. */
  timezone: string;
  summary?: PostureSummary | ExecutiveSummary;
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
    const logoH = 9;
    const aspect = branding.logoAspect && branding.logoAspect > 0 ? branding.logoAspect : 3;
    const logoW = Math.min(logoH * aspect, 46);
    const pad = 2;
    const chipW = logoW + pad * 2;
    const chipH = logoH + pad * 2;
    const chipY = yMid - chipH / 2;
    // White safe-area chip so a dark or transparent partner logo always reads on
    // the brand-colour band (letterhead convention).
    set.fill(doc, C.white);
    doc.roundedRect(PAGE.mx, chipY, chipW, chipH, 1.6, 1.6, 'F');
    try {
      doc.addImage(branding.logoDataUrl, 'PNG', PAGE.mx + pad, chipY + pad, logoW, logoH, undefined, 'FAST');
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
  doc.text(`${product.product}${cat}${coverage}`, PAGE.mx + 5, y);
  if (sync || degraded) {
    const baseW = doc.getTextWidth(`${product.product}${cat}${coverage}`);
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
  const doc = new jsPDF({ orientation: 'landscape' });
  const records = rows as Record<string, unknown>[];

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
  } else {
    renderGenericReport(doc, records, opts);
  }

  if (typeof doc.putTotalPages === 'function') {
    doc.putTotalPages(TOTAL_TOKEN);
  }
  return doc;
}
