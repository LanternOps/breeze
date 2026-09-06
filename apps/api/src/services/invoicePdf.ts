// Invoice artifact rendering + email delivery (Phase 5).
//
// Three concerns, kept separate so the heavy/IO parts are mockable and the pure
// HTML renderer is unit-testable:
//   - renderInvoiceHtml(...)  PURE — the customer-view HTML used by email + portal.
//   - renderInvoicePdf(id)    produces a REAL PDF via pdfkit and upserts invoice_documents.
//   - getInvoicePdf(id)       returns the stored bytea (or null).
//   - sendInvoiceEmail(id, …) issues if draft, ensures the PDF, emails it, stamps sent_at.
//
// PDF library choice: pdfkit (pure-JS). We deliberately do NOT pull a headless
// browser (Playwright/puppeteer) into the API production path — that's a heavy,
// fragile dependency for a container whose only job here is to draw a structured
// invoice. pdfkit draws the PDF programmatically from the same invoice+lines data
// the HTML renderer uses, so both views stay in sync. Generate-once: issued
// invoices are immutable, so the artifact never needs re-rendering.

import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceLineDevices, invoiceLines, invoiceDocuments, organizations, partners, portalBranding } from '../db/schema';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from './invoiceLinkToken';
import { escapeHtml } from './emailLayout';
import { getEmailService, buildInvoiceTemplate } from './email';
import { emitInvoiceEvent } from './invoiceEvents';
import { portalBase } from './portalUrl';
import { InvoiceServiceError } from './invoiceTypes';
import type { InvoiceActor } from './invoiceTypes';
import type { BillToAddress } from './sellerSnapshot';
import { buildSellerSnapshot, sellerAddressLines, type SellerSnapshot } from './sellerSnapshot';
import { computeChargeNow, formatMoney } from '@breeze/shared';
import { formatMoneyForPdf } from './pdfMoney';
import { fitFontSize } from './pdfFitText';
import { resolvePartnerDocumentLocale } from './documentLocale';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;

export interface InvoiceBranding {
  partnerName: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  footerText?: string | null;
  currencyCode?: string | null;
  /** Render locale for money glyphs, used only when the document carries no
   *  `document_locale` snapshot (drafts/legacy). Resolved from the partner's
   *  language by `resolvePartnerDocumentLocale`; defaults to 'en'. */
  locale?: string | null;
  /** Public view-and-pay url printed on the document ("Pay online: …"). Null
   *  for drafts (no link exists) and when minting fails — the PDF renders
   *  without the line rather than failing. */
  payOnlineUrl?: string | null;
}

export const APPENDIX_ROW_CAP = 2000;

/** One invoice line's billed devices, ready to draw. `flagged` rows are already
 *  filtered out in SQL — they were not charged. */
export interface InvoiceAppendixLine {
  lineId: string;
  description: string;
  devices: { hostname: string; deviceRole: string; countedAs: 'included' | 'overage' }[];
}

export interface InvoiceDeviceAppendix {
  lines: InvoiceAppendixLine[];
  /** Rows beyond APPENDIX_ROW_CAP that were not printed. 0 = nothing truncated. */
  omitted: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by HTML + PDF)
// ---------------------------------------------------------------------------

// Money glyphs come from the shared Intl-backed `formatMoney` (@breeze/shared).
// Locale precedence: the document's stamped `document_locale` (issue/send-time
// snapshot, never overwritten) → the branding's partner-resolved locale → 'en'.
// Formatting never changes the number, only the glyphs.
function resolveRenderLocale(invoice: { documentLocale?: string | null }, branding: InvoiceBranding): string {
  return invoice.documentLocale ?? branding.locale ?? 'en';
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value + (value.length === 10 ? 'T00:00:00Z' : '')) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

/** Per-line tax amount for the Tax column: taxable lines get lineTotal × rate
 *  rounded to cents; non-taxable lines / a non-positive rate return null (shown
 *  as '—'). The header Tax stays invoice.tax_total (authoritative), so the summed
 *  column can differ by a rounding cent on many-line invoices. */
function lineTax(lineTotal: string | number | null | undefined, taxable: boolean, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal ?? 0) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

// Title falls back to description for legacy lines created before the
// name/description split; the blurb only renders when a distinct name exists.
function lineTitle(l: { name: string | null; description: string | null }): string {
  return (l.name ?? l.description ?? '').trim() || '—';
}
function lineBlurb(l: { name: string | null; description: string | null }): string {
  return l.name ? (l.description ?? '').trim() : '';
}

function addressLines(addr: BillToAddress | null | undefined): string[] {
  if (!addr) return [];
  const cityLine = [addr.city, addr.region, addr.postalCode].filter(Boolean).join(', ');
  return [addr.line1, addr.line2, cityLine, addr.country].filter((s): s is string => !!s && s.trim().length > 0);
}

// Group customer-visible lines by ticket so the customer view reads as
// "work for ticket X" blocks; null-ticket lines fall into a default group.
interface RenderGroup { key: string; ticketId: string | null; lines: InvoiceLineRow[]; }

function groupVisibleLinesByTicket(lines: InvoiceLineRow[]): RenderGroup[] {
  const visible = lines.filter((l) => l.customerVisible);
  const groups: RenderGroup[] = [];
  const byKey = new Map<string, RenderGroup>();
  for (const l of visible) {
    const key = l.ticketId ?? '__none__';
    let g = byKey.get(key);
    if (!g) { g = { key, ticketId: l.ticketId, lines: [] }; byKey.set(key, g); groups.push(g); }
    g.lines.push(l);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// PURE: customer-view HTML (email + portal)
// ---------------------------------------------------------------------------

export function renderInvoiceHtml(invoice: InvoiceRow, lines: InvoiceLineRow[], branding: InvoiceBranding): string {
  const currency = invoice.currencyCode ?? branding.currencyCode ?? 'USD';
  const locale = resolveRenderLocale(invoice, branding);
  const primary = branding.primaryColor && /^#?[0-9a-fA-F]{3,8}$/.test(branding.primaryColor)
    ? (branding.primaryColor.startsWith('#') ? branding.primaryColor : `#${branding.primaryColor}`)
    : '#2563eb';
  const groups = groupVisibleLinesByTicket(lines);
  // Per-line Tax column appears only when this invoice carries tax (mirrors the
  // header Tax row); otherwise it'd be a column of dashes.
  const taxRate = invoice.taxRate ? Number(invoice.taxRate) : 0;
  const showTax = Number(invoice.taxTotal ?? 0) > 0;
  const billTo = addressLines(invoice.billToAddress as BillToAddress | null);
  const seller = (invoice.sellerSnapshot as SellerSnapshot | null) ?? null;
  const sellerLines = sellerAddressLines(seller);

  const logoHtml = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.partnerName)}" style="max-height:56px;max-width:220px;" />`
    : `<div style="font-size:22px;font-weight:700;color:${primary};">${escapeHtml(branding.partnerName)}</div>`;

  const rowsHtml = groups.map((g) => {
    const header = g.ticketId
      ? `<tr><td colspan="${showTax ? 4 : 3}" style="padding:10px 8px 4px;font-size:12px;font-weight:600;color:#6b7280;border-top:1px solid #e5e7eb;">Ticket work</td></tr>`
      : '';
    const lineRows = g.lines.map((l) => {
      const t = showTax ? lineTax(l.lineTotal, l.taxable, taxRate) : null;
      const taxCell = showTax
        ? `<td style="padding:6px 8px;font-size:13px;color:#6b7280;text-align:right;white-space:nowrap;">${t === null ? '&mdash;' : escapeHtml(formatMoney(t, currency, locale))}</td>`
        : '';
      return `
      <tr>
        <td style="padding:6px 8px;font-size:13px;color:#1f2937;">${escapeHtml(lineTitle(l))}${lineBlurb(l) ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">${escapeHtml(lineBlurb(l))}</div>` : ''}</td>
        <td style="padding:6px 8px;font-size:13px;color:#1f2937;text-align:right;white-space:nowrap;">${escapeHtml(String(Number(l.quantity)))}</td>
        ${taxCell}
        <td style="padding:6px 8px;font-size:13px;color:#1f2937;text-align:right;white-space:nowrap;">${escapeHtml(formatMoney(l.lineTotal, currency, locale))}</td>
      </tr>`;
    }).join('');
    return header + lineRows;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Invoice ${escapeHtml(invoice.invoiceNumber ?? '')}</title></head>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:680px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
      <div style="padding:24px;border-bottom:4px solid ${primary};display:flex;justify-content:space-between;align-items:center;">
        <div>${logoHtml}</div>
        <div style="text-align:right;">
          <div style="font-size:20px;font-weight:700;color:#111827;">INVOICE</div>
          <div style="font-size:13px;color:#6b7280;">${escapeHtml(invoice.invoiceNumber ?? 'DRAFT')}</div>
        </div>
      </div>
      <div style="padding:24px;display:flex;justify-content:space-between;gap:24px;">
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;">From</div>
          <div style="font-size:14px;font-weight:600;color:#111827;margin-top:4px;">${escapeHtml(seller?.name ?? branding.partnerName)}</div>
          ${sellerLines.map((l) => `<div style="font-size:13px;color:#4b5563;">${escapeHtml(l)}</div>`).join('')}
          ${seller?.phone ? `<div style="font-size:12px;color:#6b7280;">${escapeHtml(seller.phone)}</div>` : ''}
          ${seller?.email ? `<div style="font-size:12px;color:#6b7280;">${escapeHtml(seller.email)}</div>` : ''}
          ${seller?.website ? `<div style="font-size:12px;color:#6b7280;">${escapeHtml(seller.website)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;">Bill to</div>
          <div style="font-size:14px;font-weight:600;color:#111827;margin-top:4px;">${escapeHtml(invoice.billToName ?? '')}</div>
          ${billTo.map((l) => `<div style="font-size:13px;color:#4b5563;">${escapeHtml(l)}</div>`).join('')}
          ${invoice.billToTaxId ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">Tax ID: ${escapeHtml(invoice.billToTaxId)}</div>` : ''}
        </div>
        <div style="text-align:right;font-size:13px;color:#4b5563;">
          ${invoice.issueDate ? `<div>Issued: ${escapeHtml(formatDate(invoice.issueDate))}</div>` : ''}
          ${invoice.dueDate ? `<div>Due: ${escapeHtml(formatDate(invoice.dueDate))}</div>` : ''}
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;padding:0 24px;">
        <thead>
          <tr>
            <th style="padding:8px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Description</th>
            <th style="padding:8px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Qty</th>
            ${showTax ? '<th style="padding:8px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Tax</th>' : ''}
            <th style="padding:8px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Amount</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div style="padding:16px 24px;display:flex;justify-content:flex-end;">
        <table style="width:280px;border-collapse:collapse;">
          <tr><td style="padding:4px 8px;font-size:13px;color:#6b7280;">Subtotal</td><td style="padding:4px 8px;font-size:13px;color:#1f2937;text-align:right;">${escapeHtml(formatMoney(invoice.subtotal, currency, locale))}</td></tr>
          <tr><td style="padding:4px 8px;font-size:13px;color:#6b7280;">Tax${invoice.taxRate ? ` (${(Number(invoice.taxRate) * 100).toFixed(2)}%)` : ''}</td><td style="padding:4px 8px;font-size:13px;color:#1f2937;text-align:right;">${escapeHtml(formatMoney(invoice.taxTotal, currency, locale))}</td></tr>
          <tr><td style="padding:8px;font-size:15px;font-weight:700;color:#111827;border-top:2px solid #e5e7eb;">Total</td><td style="padding:8px;font-size:15px;font-weight:700;color:#111827;text-align:right;border-top:2px solid #e5e7eb;">${escapeHtml(formatMoney(invoice.total, currency, locale))}</td></tr>
          ${Number(invoice.amountPaid) > 0 ? `<tr><td style="padding:4px 8px;font-size:13px;color:#6b7280;">Paid</td><td style="padding:4px 8px;font-size:13px;color:#1f2937;text-align:right;">${escapeHtml(formatMoney(invoice.amountPaid, currency, locale))}</td></tr>
          <tr><td style="padding:4px 8px;font-size:14px;font-weight:600;color:#111827;">Balance due</td><td style="padding:4px 8px;font-size:14px;font-weight:600;color:#111827;text-align:right;">${escapeHtml(formatMoney(invoice.balance, currency, locale))}</td></tr>` : ''}
        </table>
      </div>
      ${invoice.notes ? `<div style="padding:0 24px 16px;font-size:13px;color:#4b5563;">${escapeHtml(invoice.notes)}</div>` : ''}
      ${invoice.termsAndConditions ? `<div style="padding:0 24px 16px;font-size:12px;color:#6b7280;"><div style="font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;margin-bottom:4px;">Terms &amp; Conditions</div>${escapeHtml(invoice.termsAndConditions)}</div>` : ''}
      ${branding.payOnlineUrl ? `<div style="padding:0 24px 16px;font-size:12px;color:#4b5563;"><strong>Pay online:</strong> <a href="${escapeHtml(branding.payOnlineUrl)}" style="color:#2563eb;">${escapeHtml(branding.payOnlineUrl)}</a></div>` : ''}
      ${(invoice.terms || branding.footerText) ? `<div style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">${escapeHtml(invoice.terms ?? branding.footerText ?? '')}</div>` : ''}
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// PDF generation (pdfkit) — draws the same structured view programmatically.
// ---------------------------------------------------------------------------

function hexToColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.startsWith('#') ? value : `#${value}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
}

export interface InvoicePdfColumns {
  left: number;
  right: number;
  contentWidth: number;
  showTax: boolean;
  /** Description column width (starts at `left`). */
  colDescW: number;
  /** QTY / TAX / AMOUNT share one right-aligned box width. */
  colNumW: number;
  colQtyX: number;
  /** Only drawn when `showTax`; equals colQtyX otherwise so callers need no branch. */
  colTaxX: number;
  colAmtX: number;
  /** Totals block amount box — wider than the line rows because the
   *  emphasised Total/Balance row draws at Helvetica-Bold 14. */
  colSummaryNumW: number;
  colSummaryAmtX: number;
  /** Totals block label box; independent of colQtyX so "Balance due" at
   *  bold 14 never wraps into the next row in the untaxed layout. */
  colSummaryLabelX: number;
  colSummaryLabelW: number;
}

// Money columns are sized for prefix-code currencies (Intl renders e.g.
// "CHF 888'888.88" — ~73pt at Helvetica 10, wider than any "$" figure), so
// the taxed layout gives qty | tax | amount 0.17 each and the description 0.44.
// The totals block gets its own wider box (0.24) for the bold-14 emphasis row:
// "CHF 1'000'000.00" at that size is ~113pt and would wrap inside the row box.
// Both the AMOUNT column and the summary box end at the table's right edge so
// the figures stay visually aligned. Exported so the test measures the real
// numbers rather than literals.
export function invoiceColumnsFor(doc: PDFKit.PDFDocument, showTax: boolean): InvoicePdfColumns {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const colSummaryNumW = contentWidth * 0.24;
  const colSummaryAmtX = right - colSummaryNumW;
  const colSummaryLabelX = colSummaryAmtX - contentWidth * 0.30;
  const colSummaryLabelW = colSummaryAmtX - colSummaryLabelX - 4;
  const summary = { colSummaryNumW, colSummaryAmtX, colSummaryLabelX, colSummaryLabelW };
  if (showTax) {
    return {
      left, right, contentWidth, showTax,
      colDescW: contentWidth * 0.44,
      colNumW: contentWidth * 0.17,
      colQtyX: left + contentWidth * 0.46,
      colTaxX: left + contentWidth * 0.64,
      colAmtX: left + contentWidth * 0.83,
      ...summary,
    };
  }
  return {
    left, right, contentWidth, showTax,
    colDescW: contentWidth * 0.60,
    colNumW: contentWidth * 0.18,
    colQtyX: left + contentWidth * 0.62,
    colTaxX: left + contentWidth * 0.62,
    // 0.82, not the historical 0.80: the AMOUNT box must end at the right
    // edge so it lines up with the totals box below it.
    colAmtX: left + contentWidth * 0.82,
    ...summary,
  };
}

/**
 * PURE: draw the invoice PDF from structured data (no DB). Exported so the pure
 * %PDF- buffer assertion can run without a database. renderInvoicePdf() loads
 * the data and calls this.
 */
export function renderInvoicePdfBuffer(
  invoice: InvoiceRow,
  lines: InvoiceLineRow[],
  branding: InvoiceBranding,
  appendix?: InvoiceDeviceAppendix | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const currency = invoice.currencyCode ?? branding.currencyCode ?? 'USD';
      const locale = resolveRenderLocale(invoice, branding);
      const primary = hexToColor(branding.primaryColor, '#2563eb');
      // Per-line Tax column only when this invoice carries tax (mirrors the header).
      const taxRate = invoice.taxRate ? Number(invoice.taxRate) : 0;
      const showTax = Number(invoice.taxTotal ?? 0) > 0;
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (d: Buffer) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentWidth = right - left;

      // Header: partner wordmark (left) + accent INVOICE eyebrow + number (right).
      doc.fillColor('#111827').fontSize(20).font('Helvetica-Bold').text(branding.partnerName, left, 50, { width: contentWidth * 0.55 });
      doc.fillColor(primary).fontSize(10).font('Helvetica-Bold').text('INVOICE', left, 52, { width: contentWidth, align: 'right', characterSpacing: 1.5 });
      doc.fillColor('#111827').fontSize(20).font('Helvetica-Bold').text(invoice.invoiceNumber ?? 'Draft', left, 66, { width: contentWidth, align: 'right' });
      doc.moveTo(left, 100).lineTo(right, 100).lineWidth(2).strokeColor(primary).stroke();

      // From (seller) — left column; Bill To — right column; dates under Bill To.
      const seller = (invoice.sellerSnapshot as SellerSnapshot | null) ?? null;
      const rightX = left + contentWidth * 0.55;
      const rightW = contentWidth * 0.45;
      let y = 120;

      doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('FROM', left, y);
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(seller?.name ?? branding.partnerName, left, y + 12, { width: contentWidth * 0.5 });
      let fromY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      for (const aline of sellerAddressLines(seller)) { doc.text(aline, left, fromY, { width: contentWidth * 0.5 }); fromY += 13; }
      doc.fillColor('#6b7280').fontSize(9);
      if (seller?.phone) { doc.text(seller.phone, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }
      if (seller?.email) { doc.text(seller.email, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }
      if (seller?.website) { doc.text(seller.website, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }

      doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('BILL TO', rightX, y, { width: rightW });
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(invoice.billToName ?? '', rightX, y + 12, { width: rightW });
      let billY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      for (const aline of addressLines(invoice.billToAddress as BillToAddress | null)) { doc.text(aline, rightX, billY, { width: rightW }); billY += 13; }
      if (invoice.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${invoice.billToTaxId}`, rightX, billY, { width: rightW }); billY += 13; }
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      if (invoice.issueDate) { doc.text(`Issued: ${formatDate(invoice.issueDate)}`, rightX, billY, { width: rightW }); billY += 14; }
      if (invoice.dueDate) { doc.text(`Due: ${formatDate(invoice.dueDate)}`, rightX, billY, { width: rightW }); billY += 14; }

      // Line table starts below the taller of the two columns. Column fractions
      // live in invoiceColumnsFor (measured by invoicePdf.test.ts).
      y = Math.max(fromY, billY) + 20;
      const { colNumW, colQtyX, colTaxX, colAmtX, colDescW, colSummaryNumW, colSummaryAmtX, colSummaryLabelX, colSummaryLabelW } = invoiceColumnsFor(doc, showTax);

      doc.save();
      doc.rect(left - 6, y - 5, contentWidth + 12, 22).fill('#f8fafc');
      doc.restore();
      doc.fillColor('#6b7280').fontSize(8.5).font('Helvetica-Bold');
      doc.text('DESCRIPTION', left, y);
      doc.text('QTY', colQtyX, y, { width: colNumW, align: 'right' });
      if (showTax) doc.text('TAX', colTaxX, y, { width: colNumW, align: 'right' });
      doc.text('AMOUNT', colAmtX, y, { width: colNumW, align: 'right' });
      y += 18;
      y += 6;

      for (const group of groupVisibleLinesByTicket(lines)) {
        if (group.ticketId) {
          doc.fillColor('#6b7280').fontSize(9).font('Helvetica-Bold').text('Ticket work', left, y); y += 14;
        }
        for (const l of group.lines) {
          if (y > doc.page.height - 140) { doc.addPage(); y = 50; }
          doc.fillColor('#1f2937').fontSize(10).font('Helvetica');
          const title = lineTitle(l);
          const blurb = lineBlurb(l);
          const titleHeight = doc.heightOfString(title, { width: colDescW });
          const blurbHeight = blurb ? doc.heightOfString(blurb, { width: colDescW }) + 2 : 0;
          const descHeight = titleHeight + blurbHeight;
          doc.font('Helvetica-Bold').text(title, left, y, { width: colDescW });
          if (blurb) {
            doc.fillColor('#6b7280').fontSize(8.5).font('Helvetica').text(blurb, left, y + titleHeight + 2, { width: colDescW });
            doc.fillColor('#1f2937').fontSize(10);
          }
          doc.font('Helvetica').text(String(Number(l.quantity)), colQtyX, y, { width: colNumW, align: 'right' });
          // Money cells: single line, shrink-to-fit. The boxes fit ~1M at 10pt
          // but numeric(12,2) permits 9'999'999'999.99, and pdfkit TRUNCATES an
          // over-wide lineBreak:false string (a different number on the invoice).
          if (showTax) {
            const t = lineTax(l.lineTotal, l.taxable, taxRate);
            const taxText = t === null ? '—' : formatMoneyForPdf(t, currency, locale);
            fitFontSize(doc, taxText, colNumW, 10);
            doc.fillColor('#6b7280').text(taxText, colTaxX, y, { width: colNumW, align: 'right', lineBreak: false });
            doc.fillColor('#1f2937');
          }
          const amountText = formatMoneyForPdf(l.lineTotal, currency, locale);
          fitFontSize(doc, amountText, colNumW, 10);
          doc.text(amountText, colAmtX, y, { width: colNumW, align: 'right', lineBreak: false });
          doc.fontSize(10);
          y += Math.max(descHeight, 12) + 6;
        }
      }

      // Totals.
      y += 6;
      doc.moveTo(colSummaryLabelX, y).lineTo(right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
      y += 8;
      const labelX = colSummaryLabelX;
      const labelW = colSummaryLabelW;
      const drawTotal = (label: string, amount: string | number, opts: { bold?: boolean; emphasis?: boolean } = {}) => {
        const { bold = false, emphasis = false } = opts;
        const strong = bold || emphasis;
        const size = emphasis ? 14 : strong ? 12 : 10;
        doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(strong ? '#111827' : '#6b7280');
        doc.text(label, labelX, y, { width: labelW, align: 'left' });
        // Shrink-to-fit + lineBreak:false: the rows advance by fixed constants,
        // so a wrapped (or pdfkit-truncated) schema-maximum figure would either
        // overprint the next row or print the wrong number.
        const amountText = formatMoneyForPdf(amount, currency, locale);
        fitFontSize(doc, amountText, colSummaryNumW, size);
        doc.fillColor(emphasis ? primary : strong ? '#111827' : '#1f2937').text(amountText, colSummaryAmtX, y, { width: colSummaryNumW, align: 'right', lineBreak: false });
        y += emphasis ? 20 : strong ? 18 : 14;
      };
      drawTotal('Subtotal', invoice.subtotal);
      drawTotal(`Tax${invoice.taxRate ? ` (${(Number(invoice.taxRate) * 100).toFixed(2)}%)` : ''}`, invoice.taxTotal);
      if (Number(invoice.amountPaid) > 0) {
        drawTotal('Total', invoice.total, { bold: true });
        drawTotal('Paid', invoice.amountPaid);
        drawTotal('Balance due', invoice.balance, { emphasis: true });
      } else {
        drawTotal('Total', invoice.total, { emphasis: true });
      }

      // Notes (memo) + Terms & Conditions + footer/terms.
      if (invoice.notes) {
        y += 14;
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('NOTES', left, y); y += 12;
        doc.fillColor('#4b5563').fontSize(10).font('Helvetica').text(invoice.notes, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      if (invoice.termsAndConditions) {
        y += 6;
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('TERMS & CONDITIONS', left, y); y += 12;
        doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(invoice.termsAndConditions, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      // Public view-and-pay link — the paper copy's route back to the online
      // invoice (the emailed CTA is the same url).
      if (branding.payOnlineUrl) {
        y += 10;
        doc.fillColor('#4b5563').fontSize(9).font('Helvetica-Bold').text('Pay online: ', left, y, { continued: true })
          .font('Helvetica').fillColor('#2563eb').text(branding.payOnlineUrl, { link: branding.payOnlineUrl });
        y = doc.y + 4;
      }
      const footer = invoice.terms ?? branding.footerText ?? null;
      if (footer) {
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica').text(footer, left, Math.max(y, doc.page.height - 110), { width: contentWidth });
      }

      // ---- #3205 W07: "Billed devices" appendix -------------------------------
      // Only `included` and `overage` rows reach here (loadDeviceAppendix filters
      // `flagged` in SQL): a device that was NOT charged must never appear on the
      // customer's document, where its presence would read as a charge. Flagged
      // devices are operator evidence and live on the internal invoice detail.
      if (appendix && appendix.lines.length > 0) {
        doc.addPage();
        let ay = 50;
        doc.fillColor('#111827').fontSize(14).font('Helvetica-Bold').text('Billed devices', left, ay);
        ay += 22;
        doc.fillColor('#6b7280').fontSize(9).font('Helvetica')
          .text('The devices counted on each line of this invoice at the time it was generated.', left, ay, { width: contentWidth });
        ay += 20;
        const colRoleX = left + contentWidth * 0.55;
        const colCountedX = left + contentWidth * 0.78;
        for (const group of appendix.lines) {
          if (ay > doc.page.height - 140) { doc.addPage(); ay = 50; }
          doc.fillColor('#1f2937').fontSize(10).font('Helvetica-Bold')
            .text(`${group.description} — ${group.devices.length}`, left, ay, { width: contentWidth });
          ay += 15;
          doc.fillColor('#9ca3af').fontSize(8).font('Helvetica-Bold');
          doc.text('Hostname', left, ay);
          doc.text('Role', colRoleX, ay);
          doc.text('Counted as', colCountedX, ay, { width: contentWidth * 0.22, align: 'right' });
          ay += 12;
          for (const d of group.devices) {
            // Same page-break idiom as the line table above.
            if (ay > doc.page.height - 140) { doc.addPage(); ay = 50; }
            doc.fillColor('#1f2937').fontSize(9).font('Helvetica');
            doc.text(d.hostname, left, ay, { width: contentWidth * 0.52, ellipsis: true });
            doc.text(d.deviceRole, colRoleX, ay, { width: contentWidth * 0.2, ellipsis: true });
            doc.fillColor('#6b7280')
              .text(d.countedAs === 'overage' ? 'Overage' : 'Included', colCountedX, ay, { width: contentWidth * 0.22, align: 'right' });
            ay += 12;
          }
          ay += 8;
        }
        if (appendix.omitted > 0) {
          if (ay > doc.page.height - 120) { doc.addPage(); ay = 50; }
          doc.fillColor('#6b7280').fontSize(9).font('Helvetica-Oblique')
            .text(`… and ${appendix.omitted} more devices — see the invoice in Breeze.`, left, ay, { width: contentWidth });
        }
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// DB-backed: load, render+store, read.
// ---------------------------------------------------------------------------

/**
 * #3205 W07: the "Billed devices" appendix rows for one invoice.
 *
 * The `counted_as <> 'flagged'` filter is IN THE SQL, applied BEFORE the cap
 * (ruling 4 + Codex item 10): flagged devices were not charged, so printing them
 * on the customer's document would read as a charge — and filtering after the
 * cap would let a line with 1,900 billed and 500 flagged devices spend its cap
 * on rows that are never printed and then falsely claim truncation.
 */
async function loadDeviceAppendix(invoiceId: string): Promise<InvoiceDeviceAppendix> {
  // Exact printable total under the SAME filter, so the truncation line can name
  // a real number. One extra count on a render is cheap; a truncation line that
  // names a wrong number is worse than an extra query.
  const [printableTotal] = await db.select({ n: count() }).from(invoiceLineDevices)
    .where(and(eq(invoiceLineDevices.invoiceId, invoiceId), ne(invoiceLineDevices.countedAs, 'flagged')));
  const rows = await db
    .select({
      lineId: invoiceLineDevices.invoiceLineId,
      description: invoiceLines.description,
      sortOrder: invoiceLines.sortOrder,
      hostname: invoiceLineDevices.hostname,
      deviceRole: invoiceLineDevices.deviceRole,
      countedAs: invoiceLineDevices.countedAs,
    })
    .from(invoiceLineDevices)
    .innerJoin(invoiceLines, eq(invoiceLines.id, invoiceLineDevices.invoiceLineId))
    .where(and(
      eq(invoiceLineDevices.invoiceId, invoiceId),
      ne(invoiceLineDevices.countedAs, 'flagged'),
    ))
    // Match billingEvidence.ts's canonical code-unit ordering exactly; relying
    // on the database's locale collation would reorder mixed-case hostnames.
    .orderBy(asc(invoiceLines.sortOrder), sql`${invoiceLineDevices.hostname} COLLATE "C"`, asc(invoiceLineDevices.id))
    .limit(APPENDIX_ROW_CAP);

  const omitted = Math.max(0, Number(printableTotal?.n ?? 0) - APPENDIX_ROW_CAP);
  const byLine = new Map<string, InvoiceAppendixLine>();
  for (const r of rows) {
    let entry = byLine.get(r.lineId);
    if (!entry) { entry = { lineId: r.lineId, description: r.description ?? '', devices: [] }; byLine.set(r.lineId, entry); }
    entry.devices.push({ hostname: r.hostname, deviceRole: r.deviceRole, countedAs: r.countedAs as 'included' | 'overage' });
  }
  return { lines: [...byLine.values()], omitted };
}

/** Load the invoice, its lines, and branding (partner name + portal logo/colors). */
async function loadInvoiceForRender(invoiceId: string): Promise<{
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
  branding: InvoiceBranding;
  appendix: InvoiceDeviceAppendix | null;
} | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) return null;
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);
  const [partner] = await db.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  // #3205 W07 decision 14a: the renderer reads the STAMP, never the partner row —
  // a change to the partner default cannot alter what an issued invoice renders.
  // A DRAFT has no stamp yet (device_appendix is still the raw override, NULL =
  // inherit), so preview resolves the inheritance; once issued it is a settled
  // boolean. Do NOT collapse these two branches into one `?? partner…`
  // expression — that would silently un-freeze every issued invoice.
  const includeDeviceAppendix = invoice.status === 'draft'
    ? (invoice.deviceAppendix ?? partner?.invoiceDeviceAppendix ?? false)
    : invoice.deviceAppendix === true;
  const appendix = includeDeviceAppendix ? await loadDeviceAppendix(invoiceId) : null;
  const [branding] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, invoice.orgId)).limit(1);
  // Legacy/draft docs have no frozen snapshot; synthesize from the live partner so
  // the From block still renders (issued docs use the frozen column).
  if (!invoice.sellerSnapshot && partner) {
    (invoice as { sellerSnapshot: unknown }).sellerSnapshot = buildSellerSnapshot(partner);
  }
  return {
    invoice,
    lines,
    appendix,
    branding: {
      // Seller-snapshot fallback before the document-type literal (#2151), so
      // the invoice PDF degrades the same way the quote side does
      // (resolveQuoteBranding) and the same way both web previews already do
      // (`branding.partnerName || seller.name`). A partner row that reads back
      // empty is an RLS/scope artifact, not a nameless partner, and the frozen
      // snapshot above still carries the company name — printing the word
      // "Invoice" in the wordmark slot (beside the header's own INVOICE
      // eyebrow) threw that away.
      // `||`, not `??`: neither name column is constrained non-empty, and a
      // blank wordmark is a worse document than the generic word.
      partnerName: partner?.name || (invoice.sellerSnapshot as SellerSnapshot | null)?.name || 'Invoice',
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? null,
      footerText: invoice.terms ?? partner?.invoiceFooter ?? branding?.footerText ?? null,
      currencyCode: invoice.currencyCode ?? partner?.currencyCode ?? 'USD',
      // Stamped snapshot wins; unstamped (draft/legacy) rows follow the
      // partner's current language.
      locale: invoice.documentLocale ?? resolvePartnerDocumentLocale(partner),
    },
  };
}

/**
 * Render the invoice PDF and upsert it into invoice_documents, then point
 * invoices.pdf_document_ref / pdf_sha256 at it. Generate-once: if a document
 * already exists for this invoice we re-render and overwrite (cheap; keeps the
 * stored artifact consistent if branding changed before send).
 *
 * Drafts are a special case: a draft can be previewed (the PDF route calls this
 * with no draft gate), but the persisted invoice_documents row + the
 * pdf_document_ref/pdf_sha256 stamps must only ever reflect the FROZEN issued
 * artifact. So for a draft we render and return the bytes for the preview but do
 * NOT persist or stamp anything — `documentId` is null to signal that.
 */
export async function renderInvoicePdf(invoiceId: string): Promise<{ documentId: string | null; sha256: string; pdf: Buffer }> {
  const loaded = await loadInvoiceForRender(invoiceId);
  if (!loaded) throw new Error(`Invoice ${invoiceId} not found for PDF render`);
  // Print the public view-and-pay link on issued documents (never drafts — no
  // link should exist for a document that hasn't been issued). Mint-or-reproduce
  // is idempotent, so re-renders keep the same url; a mint failure only drops
  // the line, never the render.
  if (loaded.invoice.status !== 'draft') {
    try {
      const link = await getOrMintInvoiceLink({
        id: loaded.invoice.id, dueDate: loaded.invoice.dueDate,
        publicLinkTokenHash: loaded.invoice.publicLinkTokenHash,
        publicLinkTokenCt: loaded.invoice.publicLinkTokenCt,
        publicLinkExpiresAt: loaded.invoice.publicLinkExpiresAt,
      });
      loaded.branding.payOnlineUrl = buildPublicInvoiceUrl(link.token);
    } catch (err) {
      console.error(`[invoicePdf] could not mint public link for PDF of invoice ${invoiceId} — rendering without the pay-online line`, err);
    }
  }
  const pdf = await renderInvoicePdfBuffer(loaded.invoice, loaded.lines, loaded.branding, loaded.appendix);
  const sha256 = createHash('sha256').update(pdf).digest('hex');

  // Preview-only for a draft: render bytes but never persist a stale artifact or
  // stamp the invoice (those belong to the immutable issued PDF). The caller gets
  // the bytes back so the preview download still works.
  if (loaded.invoice.status === 'draft') {
    return { documentId: null, sha256, pdf };
  }

  const [doc] = await db
    .insert(invoiceDocuments)
    .values({ invoiceId, orgId: loaded.invoice.orgId, pdf, sha256 })
    .onConflictDoUpdate({
      target: invoiceDocuments.invoiceId,
      set: { pdf, sha256, generatedAt: new Date() },
    })
    .returning({ id: invoiceDocuments.id });

  await db.update(invoices).set({ pdfDocumentRef: doc!.id, pdfSha256: sha256, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  return { documentId: doc!.id, sha256, pdf };
}

/** Return the stored PDF bytea for an invoice, or null if none has been rendered. */
export async function getInvoicePdf(invoiceId: string): Promise<Buffer | null> {
  const [row] = await db.select({ pdf: invoiceDocuments.pdf }).from(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, invoiceId)).limit(1);
  return row?.pdf ?? null;
}

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

/** Why the best-effort email step did not deliver. `send_failed` is reachable
 *  only on the re-send path: a first send lets a transport throw propagate
 *  (the caller is mid-issue and must learn the send failed), while a re-send
 *  changes no invoice state and so has nothing to roll back — reporting the
 *  failure honestly beats a 500 on an invoice that is already issued. */
export type SendInvoiceEmailReason = 'no_email_service' | 'no_billing_contact' | 'send_failed' | 'pdf_render_failed';

/** Result of a send attempt: the (issued) invoice plus an honest signal of
 *  whether an email was actually dispatched. `emailed:false` means the invoice
 *  IS issued (sent_at stamped, invoice.sent emitted) but no email left the box,
 *  with `reason` distinguishing "email not configured" from "no billing contact". */
export interface SendInvoiceResult {
  invoice: InvoiceRow;
  emailed: boolean;
  reason?: SendInvoiceEmailReason;
  /** Addresses the envelope actually went to (empty when nothing was sent). */
  recipients: string[];
}

/**
 * Composer fields for the customer email, shared by the send and re-send paths
 * and mirroring `SendQuoteEmailOptions`. Every field is optional: an options-less
 * call reproduces the classic "email the org billing contact with the PDF"
 * behaviour, which is what bulk-send, the MCP tools and the contract worker do.
 */
export interface SendInvoiceEmailOptions {
  /** Explicit recipients — override the org billing-contact fallback. */
  to?: string[];
  /** Extra recipients on the same envelope. */
  cc?: string[];
  /** Overrides the default "Invoice <number> from <partner>" subject. */
  subject?: string;
  /** Personal note rendered above the amounts in the customer email. */
  message?: string;
  /** false skips the PDF attachment (and its "a copy is attached" copy). */
  includePdf?: boolean;
}

/**
 * The money fields of the invoice email, isolated so the deposit-vs-balance split
 * is unit-testable without standing up the whole send path. `amountDueNow` is what
 * is owed NOW — the remaining deposit (via computeChargeNow) or the full balance —
 * NOT the invoice total, so a customer who has already paid the deposit is never
 * asked to pay the total again. `amountPaid` is omitted (undefined) when nothing
 * has been paid, so the template can suppress the "already paid" line.
 */
export function buildInvoiceEmailAmounts(inv: {
  total: string;
  depositDue: string | null;
  amountPaid: string;
  balance: string;
  currencyCode: string | null;
  documentLocale?: string | null;
}, locale?: string): { total: string; amountDueNow: string; amountPaid: string | undefined } {
  const currency = inv.currencyCode ?? 'USD';
  // Stamped document locale → caller-resolved partner locale → 'en'.
  const renderLocale = inv.documentLocale ?? locale ?? 'en';
  const chargeNow = computeChargeNow({ depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance }, currency);
  return {
    total: formatMoney(inv.total, currency, renderLocale),
    amountDueNow: formatMoney(chargeNow.amount, currency, renderLocale),
    amountPaid: Number(inv.amountPaid) > 0 ? formatMoney(inv.amountPaid, currency, renderLocale) : undefined,
  };
}

/**
 * Render (if needed) and deliver the customer invoice email.
 *
 * Shared by `sendInvoiceEmail` and `resendInvoiceEmail` — extracted so the two
 * paths can never drift on the attachment, the branded envelope, the
 * deposit-aware amounts or the recipient precedence: the details that decide
 * what a customer actually receives. Mirrors `deliverQuoteEmail`
 * (services/quoteLifecycle.ts).
 *
 * Delivery is best-effort by contract on the RE-SEND path only: `swallowThrow`
 * turns a transport failure into `reason: 'send_failed'` so an invoice that is
 * already issued isn't reported as a 500. A first send leaves it false — the
 * caller is mid-issue and a silent swallow there would mark an invoice sent
 * with nobody any the wiser.
 */
async function deliverInvoiceEmail(
  invoice: InvoiceRow,
  opts: SendInvoiceEmailOptions,
  { swallowThrow }: { swallowThrow: boolean },
): Promise<{ emailed: boolean; reason?: SendInvoiceEmailReason; recipients: string[] }> {
  const invoiceId = invoice.id;

  // Mint/reproduce the public link FIRST, from the row snapshot we hold — a
  // fresh render below also resolves the link (for the PDF's "Pay online"
  // line), and doing ours after it would hand getOrMintInvoiceLink a stale
  // snapshot that loses its own claim race on every first send.
  // (See §7 below for what the link is; failure falls back to the portal url.)
  let portalLink = `${portalBase()}/invoices/${invoiceId}`;
  let publicLinked = false;
  try {
    const link = await getOrMintInvoiceLink({
      id: invoice.id, dueDate: invoice.dueDate,
      publicLinkTokenHash: invoice.publicLinkTokenHash,
      publicLinkTokenCt: invoice.publicLinkTokenCt,
      publicLinkExpiresAt: invoice.publicLinkExpiresAt,
    });
    portalLink = buildPublicInvoiceUrl(link.token);
    publicLinked = true;
  } catch (err) {
    console.error(`[invoicePdf] could not mint public link for invoice ${invoiceId} — emailing the portal url instead`, err);
  }

  // Ensure the PDF exists (render synchronously if absent). Skipped entirely
  // when the composer dropped the attachment — there is nothing to attach and
  // no reason to pay for a render. On the re-send path a render failure is
  // part of the swallow contract (the invoice is already issued; nothing to
  // roll back) — reported as reason 'pdf_render_failed', with the audit record
  // still written by the route.
  const includePdf = opts.includePdf !== false;
  let pdf: Buffer | null = null;
  if (includePdf) {
    try {
      pdf = await getInvoicePdf(invoiceId);
      if (!pdf) {
        await renderInvoicePdf(invoiceId);
        pdf = await getInvoicePdf(invoiceId);
      }
    } catch (err) {
      if (!swallowThrow) throw err;
      console.error(`[invoicePdf] re-send PDF render failed for invoice ${invoiceId}:`, err);
      return { emailed: false, reason: 'pdf_render_failed', recipients: [] };
    }
  }

  // Resolve recipient + partner name for the email body.
  const [org] = await db.select({ billingContact: organizations.billingContact, name: organizations.name }).from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
  const [partner] = await db.select({ name: partners.name, billingEmail: partners.billingEmail, emailSignature: partners.emailSignature, settings: partners.settings }).from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  const billingRecipient = resolveBillingEmail(org?.billingContact);
  // Composer picks win; the org's billing contact is the fallback so a bare
  // send keeps working exactly as before. Normalized here (not only in the
  // route's zod schema) so a service-layer caller — MCP, bulk send — cannot
  // put a differently-cased or duplicated address on the envelope.
  const normalizedTo = Array.from(new Set(
    (opts.to ?? []).map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0),
  ));
  const recipients = normalizedTo.length > 0 ? normalizedTo : (billingRecipient ? [billingRecipient] : []);
  const cc = Array.from(new Set(
    (opts.cc ?? []).map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0),
  ));

  const emailService = getEmailService();
  if (!emailService) {
    console.warn(`[invoicePdf] Email not configured — invoice ${invoiceId} issued but not emailed`);
    return { emailed: false, reason: 'no_email_service', recipients: [] };
  }
  if (recipients.length === 0) {
    console.warn(`[invoicePdf] No billing email for org ${invoice.orgId} — invoice ${invoiceId} issued but not emailed`);
    return { emailed: false, reason: 'no_billing_contact', recipients: [] };
  }

  // §7: the email CTA is the DURABLE PUBLIC LINK — view, PDF, and pay with no
  // portal login (most invoice recipients have no portal account, and nothing
  // in this path ever invited them to one). Minted/reproduced at the top of
  // this function; `portalLink` holds the portal fallback if that failed.
  // "View & pay" only when the page will actually offer payment: payable
  // status with a balance, and the partner has a Stripe key on file. This read
  // runs in the caller's context — the send routes are partner/system scoped,
  // both of which can see the partner-axis stripe_connect_accounts row.
  let payEnabled = false;
  if (publicLinked && ['sent', 'partially_paid', 'overdue'].includes(invoice.status) && Number(invoice.balance) > 0) {
    try {
      const [stripeRow] = await db.select({ id: stripeConnectAccounts.id })
        .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, invoice.partnerId)).limit(1);
      payEnabled = stripeRow != null;
    } catch { /* label-only — never fail the send over it */ }
  }
  // This IS the "Request balance payment" action for deposit invoices: the money
  // fields reflect the deposit-vs-balance split so the email states what's owed
  // NOW, not just the invoice total (which may already be partially covered).
  const amounts = buildInvoiceEmailAmounts(invoice, resolvePartnerDocumentLocale(partner));
  const template = buildInvoiceTemplate({
    invoiceNumber: invoice.invoiceNumber ?? '',
    partnerName: partner?.name ?? 'your provider',
    total: amounts.total,
    dueDate: formatDate(invoice.dueDate),
    portalUrl: portalLink,
    amountDueNow: amounts.amountDueNow,
    amountPaid: amounts.amountPaid,
    subject: opts.subject,
    message: opts.message,
    pdfAttached: includePdf && pdf != null,
    signature: partner?.emailSignature ?? undefined,
    payEnabled,
  });
  try {
    await emailService.sendEmail({
      to: recipients,
      cc: cc.length > 0 ? cc : undefined,
      // MSP-branded envelope, mirroring the quote send path: display name
      // "<Partner> via Breeze" on the platform address (SPF/DKIM stays
      // aligned), replies routed to the MSP's billing inbox.
      from: partner?.name ? emailService.fromWithDisplayName(`${partner.name} via Breeze`) : undefined,
      replyTo: partner?.billingEmail?.trim() || undefined,
      subject: template.subject,
      html: template.html,
      text: template.text,
      attachments: pdf ? [{ filename: `${invoice.invoiceNumber ?? 'invoice'}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined,
    });
  } catch (err) {
    if (!swallowThrow) throw err;
    console.error(`[invoicePdf] re-send email failed for invoice ${invoiceId}:`, err);
    return { emailed: false, reason: 'send_failed', recipients };
  }
  return { emailed: true, recipients };
}

/**
 * Issue the invoice if it is still a draft, ensure a PDF artifact exists
 * (rendered synchronously — the email path must NOT depend on the async worker),
 * email it to the org billing contact with the PDF attached, and stamp sent_at.
 * Returns { emailed } so callers can tell the user the truth when the email
 * could not be dispatched (no email service / no billing contact) — issuance
 * still succeeds in that case (the invoice IS issued; we just couldn't email it).
 *
 * `opts` carries the composer fields when a human sent this from the web UI;
 * every caller that passes nothing gets the historical behaviour unchanged.
 */
export async function sendInvoiceEmail(
  invoiceId: string, actor: InvoiceActor, opts: SendInvoiceEmailOptions = {},
): Promise<SendInvoiceResult> {
  const { issueInvoice } = await import('./invoiceService');

  // 1. Issue if still draft. issueInvoice asserts draft but intentionally does
  //    NOT stamp sent_at (sent_at = "send attempted"); this send stamps it below.
  let [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');

  // Org-access backstop (defense-in-depth over RLS, matching getInvoice/recordPayment).
  // 404 not 403 — don't leak existence across tenants.
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(invoice.orgId)) {
    throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  }

  // Server-side lifecycle gate (the web gate is advisory): /send is the
  // FIRST-send path — it stamps sent_at and emits invoice.sent. A VOID invoice
  // is a cancelled demand, and a PAID one would email "Amount due now: $0.00";
  // a paid copy for the customer's records goes through /resend instead.
  if (invoice.status === 'void') {
    throw new InvoiceServiceError('Cannot send a void invoice', 409, 'INVALID_STATE');
  }
  if (invoice.status === 'paid') {
    throw new InvoiceServiceError('This invoice is already paid — use re-send to email a copy', 409, 'INVALID_STATE');
  }

  if (invoice.status === 'draft') {
    await issueInvoice(invoiceId, actor);
    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  }

  // 2-4. Ensure the PDF, resolve recipients, send (graceful no-op if email is
  //      not configured or no recipient is known).
  const { emailed, reason, recipients } = await deliverInvoiceEmail(invoice, opts, { swallowThrow: false });

  // 5. Stamp sent_at. This is the SOLE place sent_at is set — issueInvoice
  //    leaves it null on purpose so a plain Issue reads "Issued", and only an
  //    explicit send (this path) marks it. sent_at means "send attempted",
  //    so it's stamped even when no email service / billing contact exists
  //    (see the emailed:false case + invoicePdf.integration.test). A RE-SEND
  //    deliberately does NOT re-stamp it — see resendInvoiceEmail.
  await db.update(invoices).set({ sentAt: new Date(), updatedAt: new Date() }).where(eq(invoices.id, invoiceId));

  // 6. Emit the invoice.sent lifecycle event (spec §16). The send action has
  //    completed (issuance done + sent_at stamped) whether or not an email
  //    service was configured — emit after the DB write so a failed send never
  //    claims "sent". Fire-and-forget (a Redis outage must not fail the send).
  await emitInvoiceEvent({ type: 'invoice.sent', invoiceId, orgId: invoice.orgId, partnerId: invoice.partnerId, actorUserId: actor.userId });

  const [updated] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return { invoice: updated!, emailed, reason, recipients };
}

/**
 * Re-email an already-issued invoice — the bounced address, the deleted mail,
 * the "can you send that again?" call.
 *
 * Deliberately NOT a second send. It writes NOTHING: `sent_at` stays pinned to
 * the original issue (it means "when this invoice was first put in front of the
 * customer", and a re-send is the same document, not a new one), no
 * `invoice.sent` lifecycle event is re-emitted, and the number, snapshots and
 * status are untouched. Mirrors `resendQuote` (services/quoteLifecycle.ts).
 *
 * Refused for a DRAFT (nothing has been issued to re-send) and for a VOID
 * invoice (emailing a customer a demand we have already cancelled). A PAID
 * invoice IS re-sendable: "send me a copy for our records" is the single most
 * common reason a customer asks, and unlike a quote's accept link the invoice
 * email dispenses no credential — the portal link is gated on a portal login.
 *
 * Delivery failures are swallowed into `reason` rather than thrown: the invoice
 * is already issued, so there is no state to roll back, and a 500 here would
 * tell the tech "could not re-send" for a message that may well have gone out.
 */
export async function resendInvoiceEmail(
  invoiceId: string, actor: InvoiceActor, opts: SendInvoiceEmailOptions = {},
): Promise<SendInvoiceResult> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');

  // Org-access backstop (defense-in-depth over RLS). 404 not 403 — don't leak
  // existence across tenants.
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(invoice.orgId)) {
    throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  }

  if (invoice.status === 'draft') {
    throw new InvoiceServiceError('This invoice has not been issued yet — issue it before re-sending', 409, 'INVALID_STATE');
  }
  if (invoice.status === 'void') {
    throw new InvoiceServiceError('Cannot re-send a void invoice', 409, 'INVALID_STATE');
  }
  if (!invoice.invoiceNumber) {
    // An issued invoice always has a number (issueInvoice allocates one on the
    // way through). Missing here means the row was tampered with or half-migrated.
    throw new InvoiceServiceError('This invoice has no invoice number and cannot be re-sent', 409, 'INVALID_STATE');
  }

  const { emailed, reason, recipients } = await deliverInvoiceEmail(invoice, opts, { swallowThrow: true });
  return { invoice, emailed, reason, recipients };
}

/** Pull an email address out of the organizations.billing_contact JSONB blob. */
export function resolveBillingEmail(billingContact: unknown): string | null {
  if (billingContact && typeof billingContact === 'object') {
    const email = (billingContact as { email?: unknown }).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }
  return null;
}
