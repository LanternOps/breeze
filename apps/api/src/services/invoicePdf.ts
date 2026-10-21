// Invoice artifact rendering + email delivery (Phase 5).
//
// Concerns, kept separate so the heavy/IO parts are mockable:
//   - renderInvoicePdfBuffer(...) PURE (no DB): rows -> customer document -> PDF.
//   - drawInvoicePdf(dto, ...)    PURE: the customer document -> PDF bytes.
//   - renderInvoicePdf(id)        assembles the customer document
//                                 (assembleCustomerInvoiceDocument, surface 'pdf'),
//                                 draws it and upserts invoice_documents.
//   - getInvoicePdf(id)           returns the stored bytea (or null).
//   - sendInvoiceEmail(id, ...)   issues if draft, ensures the PDF, emails it, stamps sent_at.
//
// The PDF is drawn from the SAME customer document model the screens render
// (#9414): buildInvoiceDocumentModel -> documentPdfTable.ts, in the document's
// locale and the partner's theme fonts. There is no separate HTML renderer.
//
// PDF library choice: pdfkit (pure-JS). We deliberately do NOT pull a headless
// browser (Playwright/puppeteer) into the API production path — that's a heavy,
// fragile dependency for a container whose only job here is to draw a structured
// invoice. Generate-once: issued invoices are immutable, so the artifact never
// needs re-rendering.

import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, asc, count, eq, getTableColumns, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { invoiceAutopaySchedules, billingNoticeOutbox, invoices, invoiceLineDevices, invoiceLines, invoiceDocuments, organizations, partners, portalBranding, tickets } from '../db/schema';
import { isPartnerOnlinePaymentAvailable } from './partnerStripe';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from './invoiceLinkToken';
import { getEmailService, buildInvoiceTemplate } from './email';
import { partnerEmailCustomFromSettings } from './emailTemplates/renderPartnerEmail';
import { emitInvoiceEvent } from './invoiceEvents';
import { portalBase } from './portalUrl';
import { InvoiceServiceError } from './invoiceTypes';
import type { InvoiceActor } from './invoiceTypes';
import { buildSellerSnapshot, type SellerSnapshot } from './sellerSnapshot';
import { computeChargeNow, formatMoney, resolveInvoiceLineDetail, type InvoiceLineDetail } from '@breeze/shared';
import {
  buildInvoiceDocumentModel, documentLabelsFor, type CustomerInvoiceDocument,
} from '@breeze/shared/documents';
import { resolvePartnerDocumentLocale } from './documentLocale';
import { resolveDocumentFooter } from './documentFooter';
import { pdfPageSize, registerThemeFonts, resolvePageSize, resolveThemeId, type DocumentPageSize } from './documentThemes';
import { toCustomerInvoiceHeader } from './invoiceService';
import { assembleCustomerInvoiceDocument, projectCustomerInvoiceLines, invoiceDisplayStatus, type PreloadedBranding } from './customerDocument';
import { documentColumnsFor, drawDocumentLineTable, drawDocumentTotals, type DocumentPdfStyle } from './documentPdfTable';
import {
  resolveBillingEmail, resolveDraftBillTo, invoiceTicketNumberSql, invoiceLineTicketNumberSql,
  invoiceTicketCategorySql, invoiceLineTicketSubjectSql, invoiceLineTicketCategorySql,
} from './invoiceRenderHelpers';

export {
  resolveBillingEmail, resolveDraftBillTo, invoiceTicketNumberSql, invoiceLineTicketNumberSql,
  invoiceTicketCategorySql, invoiceLineTicketSubjectSql, invoiceLineTicketCategorySql,
};

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect & {
  ticketNumber?: string | null;
  ticketSubject?: string | null;
  ticketCategory?: string | null;
};

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
  /** DRAFT-ONLY display fallback for the BILL TO block (sweep paper cut #16),
   *  set by loadInvoiceForRender via resolveDraftBillTo — the org's billing
   *  contact email, shown only when the invoice's own billToName was blank
   *  and a fallback name/email were resolved. Never set for an issued
   *  invoice, so this is a no-op there. */
  billToEmailFallback?: string | null;
  /** Partner document page-size default, used only when the invoice carries no
   *  frozen `document_page_size` (drafts/legacy). Unset → A4. */
  pageSize?: DocumentPageSize | null;
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
// PDF generation (pdfkit) — draws the customer document model programmatically.
// ---------------------------------------------------------------------------

// Money glyphs come from the shared Intl-backed `formatMoney` (@breeze/shared).
// Locale precedence: the document's stamped `document_locale` (issue/send-time
// snapshot, never overwritten) → the branding's partner-resolved locale → 'en'.
// Formatting never changes the number, only the glyphs.
function resolveRenderLocale(invoice: { documentLocale?: string | null }, branding: InvoiceBranding): string {
  return invoice.documentLocale ?? branding.locale ?? 'en';
}

/** The due date in the invoice email body (the PDF prints dates in the document locale). */
function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value + (value.length === 10 ? 'T00:00:00Z' : '')) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function hexToColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.startsWith('#') ? value : `#${value}`;
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
}

/** What the customer document does not carry: render-only context. */
export interface InvoicePdfExtras {
  appendix?: InvoiceDeviceAppendix | null;
  /** Resolved footer (document terms -> org -> partner), used when the invoice carries no `terms`. */
  footerText?: string | null;
  /** Public view-and-pay link. */
  payOnlineUrl?: string | null;
  /** DRAFT-only display fallback under the bill-to name. */
  billToEmailFallback?: string | null;
}

/**
 * PURE: draw the invoice PDF from structured data (no DB). Exported so the pure
 * %PDF- buffer assertion can run without a database. The rows are projected
 * through the same function the customer-document assembler uses
 * (`projectCustomerInvoiceLines`, surface 'pdf'), so the PDF and the screens
 * cannot project differently. renderInvoicePdf() assembles from the database and
 * calls `drawInvoicePdf` directly.
 */
export function renderInvoicePdfBuffer(
  invoice: InvoiceRow,
  lines: InvoiceLineRow[],
  branding: InvoiceBranding,
  appendix?: InvoiceDeviceAppendix | null,
  // #8604: omitted → the invoice's own columns (frozen once issued).
  lineDetail: InvoiceLineDetail = resolveInvoiceLineDetail(invoice, null),
): Promise<Buffer> {
  const locale = resolveRenderLocale(invoice, branding);
  const dto: CustomerInvoiceDocument = {
    invoice: {
      ...toCustomerInvoiceHeader(invoice),
      lineGrouping: lineDetail.grouping,
      displayStatus: invoiceDisplayStatus(invoice.status),
    },
    lines: projectCustomerInvoiceLines(lines.filter((l) => l.customerVisible), { detail: lineDetail, surface: 'pdf', locale }),
    branding: {
      partnerName: branding.partnerName,
      contactEmail: null,
      logoUrl: branding.logoUrl ?? null,
      primaryColor: branding.primaryColor ?? null,
      // #8969 / #6227: the presentation frozen at Issue wins; drafts/legacy follow the partner default.
      theme: resolveThemeId(invoice.documentTheme),
      pageSize: resolvePageSize(invoice.documentPageSize ?? branding.pageSize),
    },
    documentLocale: locale,
  };
  return drawInvoicePdf(dto, {
    appendix, footerText: branding.footerText, payOnlineUrl: branding.payOnlineUrl, billToEmailFallback: branding.billToEmailFallback,
  });
}

/** PURE: the customer invoice document → PDF bytes. */
export function drawInvoicePdf(dto: CustomerInvoiceDocument, extras: InvoicePdfExtras = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const labels = documentLabelsFor(dto.documentLocale);
      const model = buildInvoiceDocumentModel(dto, labels);
      const locale = model.locale;
      const primary = hexToColor(dto.branding.primaryColor, '#2563eb');
      const doc = new PDFDocument({ size: pdfPageSize(dto.branding.pageSize), margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (d: Buffer) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      // Theme fonts: registerThemeFonts THROWS if a condensed face is missing (no silent Helvetica fallback).
      const fonts = registerThemeFonts(doc, dto.branding.theme);
      const style: DocumentPdfStyle = { fonts, locale, accent: primary, categoryLabel: labels.pdf.category };

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentWidth = right - left;
      const pageBottom = () => doc.page.height - doc.page.margins.bottom;
      /** Start a new page when `height` does not fit below `y`. */
      const room = (y: number, height: number) => {
        if (y > doc.page.margins.top && y + height > pageBottom()) { doc.addPage(); return doc.page.margins.top; }
        return y;
      };

      // Header: partner wordmark (left) + accent eyebrow + number (right).
      doc.fillColor('#111827').fontSize(20).font(fonts.heading.bold).text(model.branding.wordmark ?? '', left, 50, { width: contentWidth * 0.55 });
      doc.fillColor(primary).fontSize(10).font(fonts.heading.bold).text(model.header.eyebrow.toUpperCase(), left, 52, { width: contentWidth, align: 'right', characterSpacing: 1.5 });
      doc.fillColor('#111827').fontSize(20).font(fonts.heading.bold).text(dto.invoice.invoiceNumber ?? labels.status.draft, left, 66, { width: contentWidth, align: 'right' });
      doc.moveTo(left, 100).lineTo(right, 100).lineWidth(2).strokeColor(primary).stroke();

      // From (seller) — left column; Bill To — right column; dates under Bill To.
      const seller = model.branding.seller;
      const rightX = left + contentWidth * 0.55;
      const rightW = contentWidth * 0.45;
      let y = 120;

      doc.fillColor('#9ca3af').fontSize(9).font(fonts.body.bold).text(labels.pdf.from.toUpperCase(), left, y);
      doc.fillColor('#111827').fontSize(12).font(fonts.body.bold).text(seller?.name ?? model.branding.wordmark ?? '', left, y + 12, { width: contentWidth * 0.5 });
      let fromY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular);
      for (const aline of seller?.lines ?? []) { doc.text(aline, left, fromY, { width: contentWidth * 0.5 }); fromY += 13; }
      doc.fillColor('#6b7280').fontSize(9);
      if (seller?.phone) { doc.text(seller.phone, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }
      if (seller?.email) { doc.text(seller.email, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }
      if (seller?.website) { doc.text(seller.website, left, fromY, { width: contentWidth * 0.5 }); fromY += 12; }

      const billTo = model.header.billTo;
      doc.fillColor('#9ca3af').fontSize(9).font(fonts.body.bold).text(labels.billTo.toUpperCase(), rightX, y, { width: rightW });
      doc.fillColor('#111827').fontSize(12).font(fonts.body.bold).text(billTo?.name ?? '', rightX, y + 12, { width: rightW });
      let billY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular);
      for (const aline of billTo?.addressLines ?? []) { doc.text(aline, rightX, billY, { width: rightW }); billY += 13; }
      if (billTo?.taxId) { doc.fillColor('#6b7280').fontSize(9).text(labels.pdf.taxId(billTo.taxId), rightX, billY, { width: rightW }); billY += 13; }
      if (extras.billToEmailFallback) { doc.fillColor('#6b7280').fontSize(9).text(extras.billToEmailFallback, rightX, billY, { width: rightW }); billY += 13; }
      doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular);
      for (const d of model.header.dates) { doc.text(`${d.label}: ${d.value.text}`, rightX, billY, { width: rightW }); billY += 14; }

      // Line table starts below the taller of the two columns; geometry lives in
      // documentPdfTable.ts (shared with the quote PDF).
      y = Math.max(fromY, billY) + 20;
      const cols = documentColumnsFor(doc, { showTax: model.lines.columns.tax !== null });
      y = drawDocumentLineTable(doc, model.lines, y, { cols, style });

      // Totals — drawn from the model's rows; the module owns the box.
      y = drawDocumentTotals(doc, model.totals, y, { cols, style });

      // Notes (memo) + Terms & Conditions + pay-online + footer.
      if (model.notes) {
        y = room(y + 14, 40);
        doc.fillColor('#9ca3af').fontSize(9).font(fonts.body.bold).text(labels.notes.toUpperCase(), left, y); y += 12;
        doc.fillColor('#4b5563').fontSize(10).font(fonts.body.regular).text(model.notes, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      if (model.terms.full) {
        y = room(y + 6, 40);
        doc.fillColor('#9ca3af').fontSize(9).font(fonts.body.bold).text(model.terms.full.label.toUpperCase(), left, y); y += 12;
        doc.fillColor('#6b7280').fontSize(9).font(fonts.body.regular).text(model.terms.full.text, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      // Public view-and-pay link — the paper copy's route back to the online
      // invoice (the emailed CTA is the same url).
      if (extras.payOnlineUrl) {
        y = room(y + 10, 24);
        doc.fillColor('#4b5563').fontSize(9).font(fonts.body.bold).text(`${labels.pdf.payOnline} `, left, y, { continued: true })
          .font(fonts.body.regular).fillColor('#2563eb').text(extras.payOnlineUrl, { link: extras.payOnlineUrl });
        y = doc.y + 4;
      }
      // The frozen document terms win (an empty string is the frozen "no footer"), else the resolved footer.
      const footer = dto.invoice.terms ?? extras.footerText ?? null;
      if (footer) {
        doc.fillColor('#9ca3af').fontSize(9).font(fonts.body.regular).text(footer, left, Math.max(y, doc.page.height - 110), { width: contentWidth });
      }

      // ---- #3205 W07: "Billed devices" appendix -------------------------------
      // Only `included` and `overage` rows reach here (loadDeviceAppendix filters
      // `flagged` in SQL): a device that was NOT charged must never appear on the
      // customer's document, where its presence would read as a charge. Flagged
      // devices are operator evidence and live on the internal invoice detail.
      const appendix = extras.appendix;
      if (appendix && appendix.lines.length > 0) {
        doc.addPage();
        let ay = 50;
        doc.fillColor('#111827').fontSize(14).font(fonts.heading.bold).text('Billed devices', left, ay);
        ay += 22;
        doc.fillColor('#6b7280').fontSize(9).font(fonts.body.regular)
          .text('The devices counted on each line of this invoice at the time it was generated.', left, ay, { width: contentWidth });
        ay += 20;
        const colRoleX = left + contentWidth * 0.55;
        const colCountedX = left + contentWidth * 0.78;
        for (const group of appendix.lines) {
          if (ay > doc.page.height - 140) { doc.addPage(); ay = 50; }
          doc.fillColor('#1f2937').fontSize(10).font(fonts.body.bold)
            .text(`${group.description} — ${group.devices.length}`, left, ay, { width: contentWidth });
          ay += 15;
          doc.fillColor('#9ca3af').fontSize(8).font(fonts.body.bold);
          doc.text('Hostname', left, ay);
          doc.text('Role', colRoleX, ay);
          doc.text('Counted as', colCountedX, ay, { width: contentWidth * 0.22, align: 'right' });
          ay += 12;
          for (const d of group.devices) {
            // Same page-break idiom as the line table above.
            if (ay > doc.page.height - 140) { doc.addPage(); ay = 50; }
            doc.fillColor('#1f2937').fontSize(9).font(fonts.body.regular);
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
          doc.fillColor('#6b7280').fontSize(9).font(fonts.body.italic)
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

/** Load the invoice and its render context (branding, footer, appendix). The lines come from the
 *  customer-document assembler (`renderInvoicePdf`), the one place they are projected. */
export async function loadInvoiceForRender(invoiceId: string): Promise<{
  invoice: InvoiceRow;
  branding: InvoiceBranding;
  /** The partner/branding rows this loader read on the CALLER's connection, for the assembler. */
  preloaded: PreloadedBranding | undefined;
  appendix: InvoiceDeviceAppendix | null;
  /** #8604 line itemization: a draft previews override ?? partner default;
   *  anything issued reads ONLY its frozen invoices.line_* columns. */
  lineDetail: InvoiceLineDetail;
} | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) return null;
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
  // #8604: same two-branch rule as the appendix, inside the shared resolver —
  // the partner row is consulted for a draft only.
  const lineDetail = resolveInvoiceLineDetail(invoice, partner ?? null);
  const [branding] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, invoice.orgId)).limit(1);
  // Legacy/draft docs have no frozen snapshot; synthesize from the live partner so
  // the From block still renders (issued docs use the frozen column).
  if (!invoice.sellerSnapshot && partner) {
    (invoice as { sellerSnapshot: unknown }).sellerSnapshot = buildSellerSnapshot(partner);
  }
  // Draft BILL TO fallback (sweep paper cut #16) — same rationale as the
  // sellerSnapshot synthesis just above: only reached pre-issue, and mutates
  // only this in-memory object, never the invoices row. resolveDraftBillTo is
  // a no-op once issued (status !== 'draft'), so the extra org read below is
  // skipped entirely for every already-issued invoice.
  let billToEmailFallback: string | null = null;
  if (invoice.status === 'draft' && !invoice.billToName?.trim()) {
    const [org] = await db
      .select({ name: organizations.name, billingContact: organizations.billingContact })
      .from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
    const resolved = resolveDraftBillTo({
      status: invoice.status, billToName: invoice.billToName,
      orgName: org?.name ?? null, orgBillingContact: org?.billingContact ?? null,
    });
    (invoice as { billToName: string | null }).billToName = resolved.billToName;
    billToEmailFallback = resolved.billToEmail;
  }
  return {
    invoice,
    appendix,
    lineDetail,
    // Only when the partner row was visible: an org-scoped caller (the portal) reads 0 partner rows
    // under partner-axis RLS (#1375 class), and then the assembler's own system-context read must run.
    preloaded: partner
      ? {
          partner: { name: partner.name, billingEmail: partner.billingEmail, documentTheme: partner.documentTheme, documentPageSize: partner.documentPageSize, settings: partner.settings },
          brand: branding ? { logoUrl: branding.logoUrl ?? null, primaryColor: branding.primaryColor ?? null } : null,
        }
      : undefined,
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
      footerText: resolveDocumentFooter({
        documentTerms: invoice.terms,
        partnerFooter: partner?.invoiceFooter ?? null,
        brandingFooter: branding?.footerText ?? null,
      }),
      currencyCode: invoice.currencyCode ?? partner?.currencyCode ?? 'USD',
      // Stamped snapshot wins; unstamped (draft/legacy) rows follow the
      // partner's current language.
      locale: invoice.documentLocale ?? resolvePartnerDocumentLocale(partner),
      billToEmailFallback,
      // Draft/legacy fallback only; the renderer prefers invoice.documentPageSize.
      pageSize: resolvePageSize(partner?.documentPageSize),
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
  // #7509: and only when the partner can actually take online payment — the
  // line is a "Pay online" call to action, so without it the printed link is a
  // dead end. 
  // A lookup error propagates: the issued PDF is persisted and frozen, so a
  // transient fault must fail the render (retryable), not bake in a line-less copy.
  const payOnline = loaded.invoice.status !== 'draft'
    && await isPartnerOnlinePaymentAvailable(loaded.invoice.partnerId);
  if (payOnline) {
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
  // The same customer document the screens render. A draft is assembled in staff
  // mode (the only mode that accepts one); issued documents read their frozen columns.
  const assembled = await assembleCustomerInvoiceDocument(loaded.invoice, 'staff', { surface: 'pdf', preloaded: loaded.preloaded });
  const pdf = await drawInvoicePdf(
    // The loader's wordmark chain (partner -> seller snapshot -> 'Invoice') is more forgiving than the assembler's.
    // Locale and page size too: the loader's partner read THROWS on failure, the assembler's is fail-soft
    // (a blip there must not freeze an English/A4 PDF for a legacy unstamped pt-BR/Letter partner).
    {
      ...assembled,
      documentLocale: loaded.branding.locale ?? assembled.documentLocale,
      branding: {
        ...assembled.branding,
        partnerName: loaded.branding.partnerName,
        // The persisted PDF is frozen: take the strictly loaded (throwing) values, not the fail-soft ones.
        logoUrl: loaded.branding.logoUrl ?? null,
        primaryColor: loaded.branding.primaryColor ?? null,
        pageSize: resolvePageSize(loaded.invoice.documentPageSize ?? loaded.branding.pageSize),
      },
    },
    {
      appendix: loaded.appendix, footerText: loaded.branding.footerText, payOnlineUrl: loaded.branding.payOnlineUrl,
      billToEmailFallback: loaded.branding.billToEmailFallback,
    },
  );
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
 *  on both first-send and re-send paths. A failed autopay notice remains a
 *  visible send failure; a pending notice returns `notice_queued` without
 *  claiming that an invoice email was delivered. */
export type SendInvoiceEmailReason = 'no_email_service' | 'no_billing_contact' | 'send_failed' | 'pdf_render_failed' | 'notice_queued';

/** Result of a send attempt: the (issued) invoice plus an honest signal of
 *  whether an email was actually dispatched. `emailed:false` means no email
 *  was dispatched; it does not imply `sentAt` was stamped or `invoice.sent`
 *  emitted. `reason` distinguishes the specific outcome. */
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
      payEnabled = await isPartnerOnlinePaymentAvailable(invoice.partnerId);
    } catch (err) { console.error('[invoicePdf] online-payment availability lookup failed — sending with the View label', err); /* label-only — never fail the send over it */ }
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
    custom: partnerEmailCustomFromSettings(partner?.settings, 'invoice_send'),
  });
  try {
    await emailService.sendEmail({
      to: recipients,
      cc: cc.length > 0 ? cc : undefined,
      // MSP-branded envelope, mirroring the quote send path: the registry's
      // `partner_display_name` fallback renders the company name on the
      // platform address (SPF/DKIM stays aligned), replies routed to the MSP's
      // billing inbox. Both values come from rows read above (spec §8.1).
      purpose: 'invoice.sent',
      partnerId: invoice.partnerId,
      partnerName: partner?.name ?? null,
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

  const [autopay] = await db.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1);
  if (autopay?.eligible && ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled'].includes(autopay.state)) {
    const [notice] = autopay.noticeOutboxId ? await db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.id, autopay.noticeOutboxId)).limit(1) : [];
    if (notice?.status === 'sent') {
      return { invoice, emailed: true, recipients: [notice.toEmail] };
    }
    return { invoice, emailed: false, recipients: [],
      reason: notice && ['pending','sending'].includes(notice.status) ? 'notice_queued' : 'send_failed' };
  }

  // 2-4. Ensure the PDF, resolve recipients, send (graceful no-op if email is
  //      not configured or no recipient is known).
  const { emailed, reason, recipients } = await deliverInvoiceEmail(invoice, opts, { swallowThrow: false });

  // 5. Stamp sent_at for ordinary delivery. Autopay returns above and its
  //    notice-sent handler stamps delivery. issueInvoice leaves it null so a
  //    plain Issue reads "Issued". sent_at means "send attempted",
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
