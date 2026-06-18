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
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceLines, invoiceDocuments, organizations, partners, portalBranding } from '../db/schema';
import { escapeHtml } from './emailLayout';
import { getEmailService, buildInvoiceTemplate } from './email';
import { emitInvoiceEvent } from './invoiceEvents';
import { InvoiceServiceError } from './invoiceTypes';
import type { InvoiceActor } from './invoiceTypes';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;

export interface InvoiceBranding {
  partnerName: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  footerText?: string | null;
  currencyCode?: string | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by HTML + PDF)
// ---------------------------------------------------------------------------

function formatMoney(amount: string | number | null | undefined, currency: string): string {
  const n = Number(amount ?? 0);
  const symbol = currency === 'USD' ? '$' : '';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value + (value.length === 10 ? 'T00:00:00Z' : '')) : value;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

interface BillToAddress {
  line1?: string | null; line2?: string | null; city?: string | null;
  region?: string | null; postalCode?: string | null; country?: string | null;
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
  const primary = branding.primaryColor && /^#?[0-9a-fA-F]{3,8}$/.test(branding.primaryColor)
    ? (branding.primaryColor.startsWith('#') ? branding.primaryColor : `#${branding.primaryColor}`)
    : '#2563eb';
  const groups = groupVisibleLinesByTicket(lines);
  const billTo = addressLines(invoice.billToAddress as BillToAddress | null);

  const logoHtml = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.partnerName)}" style="max-height:56px;max-width:220px;" />`
    : `<div style="font-size:22px;font-weight:700;color:${primary};">${escapeHtml(branding.partnerName)}</div>`;

  const rowsHtml = groups.map((g) => {
    const header = g.ticketId
      ? `<tr><td colspan="3" style="padding:10px 8px 4px;font-size:12px;font-weight:600;color:#6b7280;border-top:1px solid #e5e7eb;">Ticket work</td></tr>`
      : '';
    const lineRows = g.lines.map((l) => `
      <tr>
        <td style="padding:6px 8px;font-size:13px;color:#1f2937;">${escapeHtml(l.description)}</td>
        <td style="padding:6px 8px;font-size:13px;color:#1f2937;text-align:right;white-space:nowrap;">${escapeHtml(String(Number(l.quantity)))}</td>
        <td style="padding:6px 8px;font-size:13px;color:#1f2937;text-align:right;white-space:nowrap;">${escapeHtml(formatMoney(l.lineTotal, currency))}</td>
      </tr>`).join('');
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
            <th style="padding:8px;text-align:right;font-size:11px;font-weight:600;letter-spacing:0.5px;color:#9ca3af;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Amount</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div style="padding:16px 24px;display:flex;justify-content:flex-end;">
        <table style="width:280px;border-collapse:collapse;">
          <tr><td style="padding:4px 8px;font-size:13px;color:#6b7280;">Subtotal</td><td style="padding:4px 8px;font-size:13px;color:#1f2937;text-align:right;">${escapeHtml(formatMoney(invoice.subtotal, currency))}</td></tr>
          <tr><td style="padding:4px 8px;font-size:13px;color:#6b7280;">Tax${invoice.taxRate ? ` (${(Number(invoice.taxRate) * 100).toFixed(2)}%)` : ''}</td><td style="padding:4px 8px;font-size:13px;color:#1f2937;text-align:right;">${escapeHtml(formatMoney(invoice.taxTotal, currency))}</td></tr>
          <tr><td style="padding:8px;font-size:15px;font-weight:700;color:#111827;border-top:2px solid #e5e7eb;">Total</td><td style="padding:8px;font-size:15px;font-weight:700;color:#111827;text-align:right;border-top:2px solid #e5e7eb;">${escapeHtml(formatMoney(invoice.total, currency))}</td></tr>
          ${Number(invoice.amountPaid) > 0 ? `<tr><td style="padding:4px 8px;font-size:13px;color:#6b7280;">Paid</td><td style="padding:4px 8px;font-size:13px;color:#1f2937;text-align:right;">${escapeHtml(formatMoney(invoice.amountPaid, currency))}</td></tr>
          <tr><td style="padding:4px 8px;font-size:14px;font-weight:600;color:#111827;">Balance due</td><td style="padding:4px 8px;font-size:14px;font-weight:600;color:#111827;text-align:right;">${escapeHtml(formatMoney(invoice.balance, currency))}</td></tr>` : ''}
        </table>
      </div>
      ${invoice.notes ? `<div style="padding:0 24px 16px;font-size:13px;color:#4b5563;">${escapeHtml(invoice.notes)}</div>` : ''}
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

/**
 * PURE: draw the invoice PDF from structured data (no DB). Exported so the pure
 * %PDF- buffer assertion can run without a database. renderInvoicePdf() loads
 * the data and calls this.
 */
export function renderInvoicePdfBuffer(invoice: InvoiceRow, lines: InvoiceLineRow[], branding: InvoiceBranding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const currency = invoice.currencyCode ?? branding.currencyCode ?? 'USD';
      const primary = hexToColor(branding.primaryColor, '#2563eb');
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (d: Buffer) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentWidth = right - left;

      // Header: partner name + INVOICE title.
      doc.fillColor(primary).fontSize(20).font('Helvetica-Bold').text(branding.partnerName, left, 50, { width: contentWidth * 0.6 });
      doc.fillColor('#111827').fontSize(18).font('Helvetica-Bold').text('INVOICE', left, 52, { width: contentWidth, align: 'right' });
      doc.fillColor('#6b7280').fontSize(10).font('Helvetica').text(invoice.invoiceNumber ?? 'DRAFT', left, 74, { width: contentWidth, align: 'right' });
      doc.moveTo(left, 96).lineTo(right, 96).lineWidth(2).strokeColor(primary).stroke();

      // Bill-to block + dates.
      let y = 112;
      doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold').text('BILL TO', left, y);
      doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(invoice.billToName ?? '', left, y + 12);
      let billY = y + 28;
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      for (const aline of addressLines(invoice.billToAddress as BillToAddress | null)) {
        doc.text(aline, left, billY); billY += 13;
      }
      if (invoice.billToTaxId) { doc.fillColor('#6b7280').fontSize(9).text(`Tax ID: ${invoice.billToTaxId}`, left, billY); billY += 13; }

      const dateX = left + contentWidth * 0.6;
      let dateY = y;
      doc.fillColor('#4b5563').fontSize(10).font('Helvetica');
      if (invoice.issueDate) { doc.text(`Issued: ${formatDate(invoice.issueDate)}`, dateX, dateY, { width: contentWidth * 0.4, align: 'right' }); dateY += 14; }
      if (invoice.dueDate) { doc.text(`Due: ${formatDate(invoice.dueDate)}`, dateX, dateY, { width: contentWidth * 0.4, align: 'right' }); dateY += 14; }

      // Line table.
      y = Math.max(billY, dateY) + 20;
      const colQtyX = left + contentWidth * 0.62;
      const colAmtX = left + contentWidth * 0.80;
      const colDescW = contentWidth * 0.60;
      const colNumW = contentWidth * 0.18;

      doc.fillColor('#9ca3af').fontSize(9).font('Helvetica-Bold');
      doc.text('DESCRIPTION', left, y);
      doc.text('QTY', colQtyX, y, { width: colNumW, align: 'right' });
      doc.text('AMOUNT', colAmtX, y, { width: colNumW, align: 'right' });
      y += 14;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
      y += 6;

      for (const group of groupVisibleLinesByTicket(lines)) {
        if (group.ticketId) {
          doc.fillColor('#6b7280').fontSize(9).font('Helvetica-Bold').text('Ticket work', left, y); y += 14;
        }
        for (const l of group.lines) {
          if (y > doc.page.height - 140) { doc.addPage(); y = 50; }
          doc.fillColor('#1f2937').fontSize(10).font('Helvetica');
          const descHeight = doc.heightOfString(l.description, { width: colDescW });
          doc.text(l.description, left, y, { width: colDescW });
          doc.text(String(Number(l.quantity)), colQtyX, y, { width: colNumW, align: 'right' });
          doc.text(formatMoney(l.lineTotal, currency), colAmtX, y, { width: colNumW, align: 'right' });
          y += Math.max(descHeight, 12) + 6;
        }
      }

      // Totals.
      y += 6;
      doc.moveTo(colQtyX, y).lineTo(right, y).lineWidth(1).strokeColor('#e5e7eb').stroke();
      y += 8;
      const labelX = colQtyX;
      const labelW = colAmtX - colQtyX - 4;
      const drawTotal = (label: string, amount: string | number, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? '#111827' : '#6b7280');
        doc.text(label, labelX, y, { width: labelW, align: 'left' });
        doc.fillColor(bold ? '#111827' : '#1f2937').text(formatMoney(amount, currency), colAmtX, y, { width: colNumW, align: 'right' });
        y += bold ? 18 : 14;
      };
      drawTotal('Subtotal', invoice.subtotal);
      drawTotal(`Tax${invoice.taxRate ? ` (${(Number(invoice.taxRate) * 100).toFixed(2)}%)` : ''}`, invoice.taxTotal);
      drawTotal('Total', invoice.total, true);
      if (Number(invoice.amountPaid) > 0) {
        drawTotal('Paid', invoice.amountPaid);
        drawTotal('Balance due', invoice.balance, true);
      }

      // Notes + footer/terms.
      if (invoice.notes) {
        y += 14;
        doc.fillColor('#4b5563').fontSize(10).font('Helvetica').text(invoice.notes, left, y, { width: contentWidth });
        y = doc.y + 8;
      }
      const footer = invoice.terms ?? branding.footerText ?? null;
      if (footer) {
        doc.fillColor('#9ca3af').fontSize(9).font('Helvetica').text(footer, left, Math.max(y, doc.page.height - 110), { width: contentWidth });
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

/** Load the invoice, its lines, and branding (partner name + portal logo/colors). */
async function loadInvoiceForRender(invoiceId: string): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[]; branding: InvoiceBranding } | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!invoice) return null;
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);
  const [partner] = await db.select({ name: partners.name, footer: partners.invoiceFooter, currency: partners.currencyCode }).from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  const [branding] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, invoice.orgId)).limit(1);
  return {
    invoice,
    lines,
    branding: {
      partnerName: partner?.name ?? 'Invoice',
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? null,
      footerText: invoice.terms ?? partner?.footer ?? branding?.footerText ?? null,
      currencyCode: invoice.currencyCode ?? partner?.currency ?? 'USD',
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
  const pdf = await renderInvoicePdfBuffer(loaded.invoice, loaded.lines, loaded.branding);
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

/** Result of a send attempt: the (issued) invoice plus an honest signal of
 *  whether an email was actually dispatched. `emailed:false` means the invoice
 *  IS issued (sent_at stamped, invoice.sent emitted) but no email left the box,
 *  with `reason` distinguishing "email not configured" from "no billing contact". */
export interface SendInvoiceResult {
  invoice: InvoiceRow;
  emailed: boolean;
  reason?: 'no_email_service' | 'no_billing_contact';
}

/**
 * Issue the invoice if it is still a draft, ensure a PDF artifact exists
 * (rendered synchronously — the email path must NOT depend on the async worker),
 * email it to the org billing contact with the PDF attached, and stamp sent_at.
 * Returns { emailed } so callers can tell the user the truth when the email
 * could not be dispatched (no email service / no billing contact) — issuance
 * still succeeds in that case (the invoice IS issued; we just couldn't email it).
 */
export async function sendInvoiceEmail(invoiceId: string, actor: InvoiceActor): Promise<SendInvoiceResult> {
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

  if (invoice.status === 'draft') {
    await issueInvoice(invoiceId, actor);
    [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  }

  // 2. Ensure the PDF exists (render synchronously if absent).
  let pdf = await getInvoicePdf(invoiceId);
  if (!pdf) {
    await renderInvoicePdf(invoiceId);
    pdf = await getInvoicePdf(invoiceId);
  }

  // 3. Resolve recipient + partner name for the email body.
  const [org] = await db.select({ billingContact: organizations.billingContact, name: organizations.name }).from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
  const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  const recipient = resolveBillingEmail(org?.billingContact);

  // 4. Send (graceful no-op if email is not configured or no recipient is known).
  //    Track whether an email actually went out so the caller can report honestly.
  const emailService = getEmailService();
  let emailed = false;
  let reason: SendInvoiceResult['reason'];
  if (emailService && recipient) {
    // The customer portal is served under PUBLIC_PORTAL_URL (e.g.
    // https://<domain>/c); the invoice detail page lives at <portal>/invoices/<id>.
    // Fall back to the app/dashboard origin when the portal URL isn't configured.
    const portalBase = (
      process.env.PUBLIC_PORTAL_URL ||
      process.env.PUBLIC_APP_URL ||
      process.env.DASHBOARD_URL ||
      'http://localhost:4321'
    ).replace(/\/$/, '');
    const portalLink = `${portalBase}/invoices/${invoiceId}`;
    const template = buildInvoiceTemplate({
      invoiceNumber: invoice.invoiceNumber ?? '',
      partnerName: partner?.name ?? 'your provider',
      total: formatMoney(invoice.total, invoice.currencyCode ?? 'USD'),
      dueDate: formatDate(invoice.dueDate),
      portalUrl: portalLink,
    });
    await emailService.sendEmail({
      to: recipient,
      subject: template.subject,
      html: template.html,
      text: template.text,
      attachments: pdf ? [{ filename: `${invoice.invoiceNumber ?? 'invoice'}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined,
    });
    emailed = true;
  } else if (!emailService) {
    reason = 'no_email_service';
    console.warn(`[invoicePdf] Email not configured — invoice ${invoiceId} issued but not emailed`);
  } else {
    reason = 'no_billing_contact';
    console.warn(`[invoicePdf] No billing email for org ${invoice.orgId} — invoice ${invoiceId} issued but not emailed`);
  }

  // 5. Stamp sent_at. This is the SOLE place sent_at is set — issueInvoice
  //    leaves it null on purpose so a plain Issue reads "Issued", and only an
  //    explicit send (this path) marks it. sent_at means "send attempted",
  //    so it's stamped even when no email service / billing contact exists
  //    (see the emailed:false case + invoicePdf.integration.test).
  await db.update(invoices).set({ sentAt: new Date(), updatedAt: new Date() }).where(eq(invoices.id, invoiceId));

  // 6. Emit the invoice.sent lifecycle event (spec §16). The send action has
  //    completed (issuance done + sent_at stamped) whether or not an email
  //    service was configured — emit after the DB write so a failed send never
  //    claims "sent". Fire-and-forget (a Redis outage must not fail the send).
  await emitInvoiceEvent({ type: 'invoice.sent', invoiceId, orgId: invoice.orgId, partnerId: invoice.partnerId, actorUserId: actor.userId });

  const [updated] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return { invoice: updated!, emailed, reason };
}

/** Pull an email address out of the organizations.billing_contact JSONB blob. */
export function resolveBillingEmail(billingContact: unknown): string | null {
  if (billingContact && typeof billingContact === 'object') {
    const email = (billingContact as { email?: unknown }).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }
  return null;
}
