import { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';
import type { PostureSummary } from '@breeze/shared';

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
  warning: [196, 128, 12] as RGB, //      --warning, darkened for text contrast
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

type BuildOpts = {
  reportType: string;
  /** Already-formatted, timezone-correct generation timestamp. */
  generatedAt: string;
  /** IANA timezone for formatting ISO date cells in generic tables. */
  timezone: string;
  summary?: PostureSummary;
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

/** Three white "gust" strokes evoking the Breeze wind mark, for the band. */
function drawBreezeMark(doc: jsPDF, x: number, yMid: number): void {
  set.draw(doc, C.white);
  doc.setLineCap('round');
  doc.setLineWidth(1.1);
  doc.line(x, yMid - 2.3, x + 6.6, yMid - 2.3);
  doc.line(x - 1, yMid, x + 8.2, yMid);
  doc.line(x + 0.6, yMid + 2.3, x + 5.6, yMid + 2.3);
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
    drawBreezeMark(doc, PAGE.mx + 3, yMid);
    set.text(doc, C.white);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(name, PAGE.mx + 13, yMid + 1.4, { baseline: 'middle' });
  }

  // Right side: document category label.
  set.text(doc, C.bandText);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(titleCase(reportType).toUpperCase(), PAGE.w - PAGE.mx, yMid + 1, {
    align: 'right',
    baseline: 'middle',
  });
}

function drawFooter(doc: jsPDF): void {
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
  doc.text('Generated by Breeze RMM', PAGE.mx, y);
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

/** Two-column metric grid: dot + label … coloured value + muted target hint. */
function drawMetricGrid(doc: jsPDF, metrics: Metric[], top: number): number {
  const colW = (PAGE.w - PAGE.mx * 2 - 8) / 2;
  const rowH = 6.4;
  const rows = Math.ceil(metrics.length / 2);
  metrics.forEach((m, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = PAGE.mx + col * (colW + 8);
    const y = top + row * rowH;
    // status dot
    set.fill(doc, STATUS_COLOR[m.status]);
    doc.circle(x + 1.4, y - 1.2, 1.2, 'F');
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
  const items: [RGB, string][] = [
    [C.success, 'Meets target'],
    [C.warning, 'Needs attention'],
    [C.danger, 'At risk'],
    [C.faint, 'Not assessed'],
  ];
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  const dotGap = 2.4;
  const itemGap = 6;
  const widths = items.map(([, t]) => 2 + dotGap + doc.getTextWidth(t));
  const total = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
  let x = PAGE.w - PAGE.mx - total;
  items.forEach(([color, label], i) => {
    set.fill(doc, color);
    doc.circle(x + 1, y - 1.1, 1.1, 'F');
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

type PostureAggregates = { criticalCount: number; unprotectedCount: number };

function renderPostureCover(
  doc: jsPDF,
  summary: PostureSummary,
  opts: BuildOpts,
  agg: PostureAggregates,
): void {
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
    const protectedPct = c.anyAvCoveragePct;
    const caption =
      protectedPct != null ? `${protectedPct}% of devices running real-time protection` : '';
    const unprotected = c.unprotectedCount ?? agg.unprotectedCount;
    const protectedCount = Math.max(0, deviceCount - unprotected);
    const stats: ScoreStat[] = [
      { label: 'Protected', value: `${protectedCount}/${deviceCount}`, tone: unprotected > 0 ? C.warning : C.success },
      { label: 'Critical findings', value: String(agg.criticalCount), tone: agg.criticalCount > 0 ? C.danger : C.success },
      { label: 'Unprotected', value: String(unprotected), tone: unprotected > 0 ? C.danger : C.success },
    ];
    y = drawScorecard(doc, summary.postureScore, caption, stats, y);
  }

  const ccHeadingY = y + 2;
  y = drawSectionHeading(doc, 'Control coverage', ccHeadingY);
  drawLegend(doc, ccHeadingY); // color key, right-aligned to the heading
  const metrics: Metric[] = [
    { label: 'Managed EDR coverage', value: pctStr(c.edrCoveragePct), status: pctStatus(c.edrCoveragePct), target: '>=90%' },
    { label: 'AV + real-time protection', value: pctStr(c.anyAvCoveragePct), status: pctStatus(c.anyAvCoveragePct), target: '>=95%' },
    {
      label: 'Unprotected devices',
      value: String(c.unprotectedCount ?? 0),
      status: (c.unprotectedCount ?? 0) > 0 ? 'bad' : 'good',
      target: '0',
    },
    { label: 'AV definitions current', value: pctStr(c.avDefinitionsCurrentPct), status: pctStatus(c.avDefinitionsCurrentPct), target: '>=95%' },
    { label: 'Disk encryption', value: pctStr(c.encryptionPct), status: pctStatus(c.encryptionPct), target: '>=90%' },
    { label: 'Host firewall', value: pctStr(c.firewallPct), status: pctStatus(c.firewallPct), target: '>=95%' },
    { label: 'Patch current (no critical pending)', value: pctStr(c.patchCurrentPct), status: pctStatus(c.patchCurrentPct, 90, 70), target: '>=90%' },
    { label: 'Password complexity', value: pctStr(c.passwordComplexityPct), status: pctStatus(c.passwordComplexityPct), target: '>=90%' },
    { label: 'Local-admin exposure', value: pctStr(c.localAdminExposurePct), status: pctStatus(c.localAdminExposurePct == null ? null : 100 - c.localAdminExposurePct), target: '<=10%' },
    { label: 'Identity provider connected', value: yesNo(c.identityProviderConnected), status: boolStatus(c.identityProviderConnected) },
    {
      label: 'Backup configured',
      value: `${yesNo(c.backupConfigured)}${c.backupConfigured && c.backupEncrypted ? ' (encrypted)' : ''}`,
      status: boolStatus(c.backupConfigured),
    },
    { label: 'DNS filtering active', value: yesNo(c.dnsFilteringActive), status: boolStatus(c.dnsFilteringActive) },
  ];
  if (c.cisIncluded !== false) {
    const cisVal =
      c.cisAvgPassRate == null
        ? 'Not assessed'
        : `${c.cisAvgPassRate}% (${c.cisAssessedCount ?? 0}/${deviceCount})`;
    metrics.push({ label: 'CIS hardening', value: cisVal, status: pctStatus(c.cisAvgPassRate, 90, 70), target: '>=90%' });
  }
  y = drawMetricGrid(doc, metrics, y);

  y = drawSectionHeading(doc, 'Privileged access (PAM)', y + 3);
  const pamMetrics: Metric[] = [
    { label: 'UAC interception', value: p.uacInterceptionEnabled ? 'Enabled' : 'Disabled', status: p.uacInterceptionEnabled ? 'good' : 'warn' },
    { label: 'Active PAM rules', value: String(p.activePamRules ?? 0), status: (p.activePamRules ?? 0) > 0 ? 'good' : 'neutral' },
    {
      label: 'Elevations in window',
      value: `${p.elevationsInWindow ?? 0} (${p.elevationsApproved ?? 0} appr / ${p.elevationsDenied ?? 0} den)`,
      status: 'neutral',
    },
    { label: 'MFA step-up enforced', value: yesNo(p.mfaStepUpEnforced), status: boolStatus(p.mfaStepUpEnforced) },
  ];
  y = drawMetricGrid(doc, pamMetrics, y);

  const products = summary.securityProducts ?? [];
  if (products.length > 0) {
    y = drawSectionHeading(doc, 'Security products in use', y + 3);
    set.text(doc, C.ink);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (const prod of products) {
      const catLabel = PRODUCT_CATEGORY_LABELS[prod.category] ?? prod.category;
      // Skip the category tag when the product name already conveys it
      // (avoids "Backup (local) (Backup)").
      const cat = prod.product.toLowerCase().includes(catLabel.toLowerCase()) ? '' : ` (${catLabel})`;
      const coverage = prod.deviceCoverage != null ? ` — ${prod.deviceCoverage} devices` : '';
      const sync = prod.lastSyncStatus ? ` [sync: ${prod.lastSyncStatus}]` : '';
      const degraded = prod.active === false ? ' — DEGRADED' : '';
      set.fill(doc, prod.active === false ? C.warning : C.success);
      doc.circle(PAGE.mx + 1.4, y - 1.2, 1.2, 'F');
      set.text(doc, C.ink);
      doc.text(`${prod.product}${cat}${coverage}${sync}${degraded}`, PAGE.mx + 5, y);
      y += 5.6;
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
  { key: 'avDefinitionsAgeDays', label: 'AV Age (d)', w: 16, halign: 'center' },
  { key: 'encryption', label: 'Encryption', w: 22, halign: 'center' },
  { key: 'firewall', label: 'Firewall', w: 16, halign: 'center' },
  { key: 'localAdmins', label: 'Local Admins', w: 19, halign: 'center' },
  { key: 'pendingPatches', label: 'Pending', w: 16, halign: 'center' },
  { key: 'criticalPatches', label: 'Critical', w: 16, halign: 'center' },
  { key: 'openVulnHigh', label: 'Vuln High', w: 16, halign: 'center' },
  { key: 'openVulnCritical', label: 'Vuln Crit', w: 16, halign: 'center' },
  { key: 'cisPassRate', label: 'CIS %', w: 14, halign: 'center' },
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
  edr: 'EDR',
  mdr: 'MDR',
  dns_filtering: 'DNS filtering',
  backup: 'Backup',
  identity: 'Identity',
};

/** Colour for a posture body cell, keyed by column. null = inherit default ink. */
function postureCellColor(key: string, raw: unknown): RGB | null {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const n = num(raw);
  if (raw == null || s === '' || s === 'no data' || s === 'n/a' || s === '—') return C.faint;
  switch (key) {
    case 'firewall':
      return raw === true || s === 'yes' ? C.success : raw === false || s === 'no' ? C.danger : null;
    case 'encryption':
      return /encrypt|enabled|on|yes/.test(s) ? C.success : /no|off|disabled/.test(s) ? C.danger : null;
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

function renderPostureTable(doc: jsPDF, rows: Record<string, unknown>[], opts: BuildOpts): void {
  doc.addPage();
  drawTitleBlock(doc, 'Per-device detail', '', `${rows.length} device${rows.length === 1 ? '' : 's'}`, PAGE.bandH + 8);
  const head = [POSTURE_COLUMNS.map((col) => col.label)];
  const body = rows.map((row) => POSTURE_COLUMNS.map((col) => formatPostureCell(col.key, row[col.key])));
  const columnStyles: Record<number, { cellWidth: number; halign: 'left' | 'center' }> = {};
  POSTURE_COLUMNS.forEach((col, i) => {
    columnStyles[i] = { cellWidth: col.w, halign: col.halign };
  });

  // Totals row: sum the count columns, average CIS, so the evidence table
  // closes with a fleet-level rollup the per-row detail doesn't give.
  const sum = (key: string) => rows.reduce((a, r) => a + (num(r[key]) ?? 0), 0);
  const cisVals = rows.map((r) => num(r.cisPassRate)).filter((n): n is number => n != null);
  const cisAvg = cisVals.length ? Math.round(cisVals.reduce((a, b) => a + b, 0) / cisVals.length) : null;
  const foot = [
    POSTURE_COLUMNS.map((col) => {
      switch (col.key) {
        case 'hostname':
          return `Totals · ${rows.length} device${rows.length === 1 ? '' : 's'}`;
        case 'localAdmins':
          return String(sum('localAdmins'));
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
    styles: { fontSize: 7.5, cellPadding: 1.8, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
    headStyles: { fillColor: C.primary, textColor: C.white, fontStyle: 'bold', fontSize: 7.5, lineColor: C.primary },
    footStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold', fontSize: 7.5, lineColor: C.rule },
    alternateRowStyles: { fillColor: C.zebra },
    columnStyles,
    didParseCell: (data: CellHookData) => {
      const col = POSTURE_COLUMNS[data.column.index];
      if (!col) return;
      if (data.section === 'body') {
        const raw = rows[data.row.index]?.[col.key];
        const color = postureCellColor(col.key, raw);
        if (color) {
          data.cell.styles.textColor = color;
          if (color === C.danger) data.cell.styles.fontStyle = 'bold';
        }
      } else if (data.section === 'foot') {
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
      drawFooter(doc);
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
  const title = titleCase(opts.reportType);
  drawTitleBlock(doc, title, '', `Generated ${opts.generatedAt}   ·   ${rows.length} record${rows.length === 1 ? '' : 's'}`, PAGE.bandH + 8);

  if (rows.length === 0) {
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text('No data available for the selected filters.', PAGE.mx, PAGE.bandH + 26);
    drawHeaderBand(doc, opts);
    drawFooter(doc);
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
      drawFooter(doc);
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

  if (opts.reportType === 'security_compliance_posture' && opts.summary) {
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
    renderPostureCover(doc, opts.summary, opts, agg);
    // Draw chrome on the cover page (no autotable runs on it).
    drawHeaderBand(doc, opts);
    drawFooter(doc);
    if (records.length > 0) {
      renderPostureTable(doc, records, opts);
    }
  } else {
    renderGenericReport(doc, records, opts);
  }

  if (typeof doc.putTotalPages === 'function') {
    doc.putTotalPages(TOTAL_TOKEN);
  }
  return doc;
}
