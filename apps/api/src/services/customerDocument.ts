/**
 * The customer-document assembler (#9402, spec §3.4). The ONLY code that turns
 * invoice rows into the customer DTO: the public link, the logged-in portal and
 * the staff Preview (`GET /invoices/:id/customer-view`) all return its output,
 * so who-sees-what has one implementation.
 *
 * Contract:
 *  - The caller passes the row it ALREADY authorized (public token resolve,
 *    portal org guard, staff requireInvoiceAccess). Eligibility stays in the
 *    routes; this module shapes data and never decides who may see it.
 *  - Hidden lines (`customer_visible = false`) never leave here, in any mode:
 *    the single line query filters them in SQL.
 *  - #8604 line-detail withholding runs only in `toCustomerInvoiceLine`.
 *  - `mode` controls draft acceptance (staff only) and draft line-detail
 *    resolution; it never widens the row filter.
 *
 * Import direction: this file imports invoiceService.ts, never the reverse.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { InvoiceLineDetail, InvoiceStatus } from '@breeze/shared';
import type {
  CustomerDocumentBrandingDto, CustomerDocumentMode, CustomerInvoiceDocument, CustomerInvoiceLineDto,
} from '@breeze/shared/documents';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { invoiceLines, invoices, partners, tickets } from '../db/schema';
import { portalBranding } from '../db/schema/portal';
import {
  customerLineDetail, resolveDocumentLineDetail, toCustomerInvoiceHeader, toCustomerInvoiceLine,
} from './invoiceService';
import { invoiceLineTicketCategorySql, invoiceLineTicketNumberSql, invoiceLineTicketSubjectSql } from './invoicePdf';
import { resolveInvoicePresentation } from './invoicePresentation';
import { resolvePartnerDocumentLocale } from './documentLocale';

export type { CustomerDocumentMode } from '@breeze/shared/documents';
export type InvoiceRow = typeof invoices.$inferSelect;
export type DocumentSurface = 'screen' | 'pdf';

/** OD-9 (#9402) — pending Todd. Flip the line for a surface when the ruling lands.
 *  The projection itself carries or withholds the data, so a withheld field is
 *  never on the wire (a builder-only flag would leave it there). */
export const OD9_CUSTOMER_PROJECTION = {
  screen: { ticketSubject: false, bundleNesting: false }, // web Preview + portal public + portal logged-in (W1 invoices, W2 quotes)
  pdf:    { ticketSubject: true,  bundleNesting: false }, // invoicePdf/quotePdf via the assembler (W3); keeps today's PDF subject
} as const;

/** A route asked for a document its mode may not see (a draft outside staff
 *  mode). A programming error: routes refuse drafts before calling, so this
 *  must never become an HTTP response body. */
export class CustomerDocumentModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerDocumentModeError';
  }
}

/** The pill the customer sees: the status, or none for a draft. */
export function invoiceDisplayStatus(status: InvoiceStatus): Exclude<InvoiceStatus, 'draft'> | null {
  return status === 'draft' ? null : status;
}

/**
 * The single customer line query: the invoice's own lines in its own org,
 * customer-visible only, tickets joined within the org and skipping deleted
 * ones. Maps through `toCustomerInvoiceLine` (the #8604 boundary), then adds
 * the OD-9 keys only when the surface's switch is on — omitted, never
 * `undefined`, when off.
 */
export async function loadCustomerInvoiceLines(
  invoice: InvoiceRow,
  opts: { detail: InvoiceLineDetail; surface: DocumentSurface },
): Promise<CustomerInvoiceLineDto[]> {
  const rows = await db.select({
    id: invoiceLines.id,
    parentLineId: invoiceLines.parentLineId,
    ticketId: invoiceLines.ticketId,
    ticketNumber: invoiceLineTicketNumberSql(invoice.status),
    ticketSubject: invoiceLineTicketSubjectSql(invoice.status),
    ticketCategory: invoiceLineTicketCategorySql(invoice.status),
    name: invoiceLines.name,
    description: invoiceLines.description,
    quantity: invoiceLines.quantity,
    unitPrice: invoiceLines.unitPrice,
    taxable: invoiceLines.taxable,
    lineTotal: invoiceLines.lineTotal,
    workedMinutes: invoiceLines.workedMinutes,
    sourceType: invoiceLines.sourceType,
    workDate: invoiceLines.workDate,
  }).from(invoiceLines)
    .leftJoin(tickets, and(
      eq(tickets.id, invoiceLines.ticketId),
      eq(tickets.orgId, invoice.orgId),
      isNull(tickets.deletedAt),
    ))
    .where(and(
      eq(invoiceLines.invoiceId, invoice.id),
      eq(invoiceLines.orgId, invoice.orgId),
      eq(invoiceLines.customerVisible, true),
    ))
    .orderBy(invoiceLines.sortOrder);

  const flags = OD9_CUSTOMER_PROJECTION[opts.surface];
  const locale = invoice.documentLocale ?? 'en';
  return rows.map((r) => {
    const line: CustomerInvoiceLineDto = toCustomerInvoiceLine(r, opts.detail, locale);
    if (flags.ticketSubject) line.ticketSubject = r.ticketSubject ?? null;
    if (flags.bundleNesting) line.isChild = r.parentLineId != null;
    return line;
  });
}

type DocumentPartner = {
  name: string | null;
  billingEmail: string | null;
  documentTheme: string | null;
  documentPageSize: string | null;
  settings: unknown;
};

/**
 * Branding plus the partner row it was read from (shared with the locale
 * chain). `partners` is partner-axis RLS — invisible to an org-scoped portal
 * caller (#1375 class: 0 rows, no error) — so it reads in the system context,
 * keyed on the invoice's own partnerId. `portal_branding` is org-scoped and
 * reads in the caller's context (the public route's caller context is already
 * system). Fail-soft, as the portal always was: branding is decoration on a
 * document the customer came to read or pay.
 */
async function loadBrandingAndPartner(
  invoice: InvoiceRow,
): Promise<{ branding: CustomerDocumentBrandingDto; partner: DocumentPartner | null }> {
  try {
    const [partner] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({
        name: partners.name,
        billingEmail: partners.billingEmail,
        documentTheme: partners.documentTheme,
        documentPageSize: partners.documentPageSize,
        settings: partners.settings,
      }).from(partners).where(eq(partners.id, invoice.partnerId)).limit(1)));
    const [brand] = await db
      .select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, invoice.orgId))
      .limit(1);
    return {
      partner: partner ?? null,
      branding: {
        partnerName: partner?.name ?? null,
        contactEmail: partner?.billingEmail ?? null,
        logoUrl: brand?.logoUrl ?? null,
        primaryColor: brand?.primaryColor ?? null,
        // #6227: the invoice's issue-time snapshot; partner live values only for a draft.
        ...resolveInvoicePresentation(invoice, partner),
      },
    };
  } catch (err) {
    console.error('[customerDocument] branding lookup failed', { invoiceId: invoice.id, err });
    return {
      partner: null,
      branding: {
        partnerName: null, contactEmail: null, logoUrl: null, primaryColor: null,
        ...resolveInvoicePresentation(invoice, undefined),
      },
    };
  }
}

/** The document's branding block (fail-soft; see loadBrandingAndPartner). */
export async function loadCustomerDocumentBranding(invoice: InvoiceRow): Promise<CustomerDocumentBrandingDto> {
  return (await loadBrandingAndPartner(invoice)).branding;
}

/**
 * Assemble the customer invoice document for an already-authorized row.
 * `mode` is who it is for; `surface` picks the OD-9 projection (default screen).
 */
export async function assembleCustomerInvoiceDocument(
  invoice: InvoiceRow,
  mode: CustomerDocumentMode,
  opts: { surface?: DocumentSurface } = {},
): Promise<CustomerInvoiceDocument> {
  const isDraft = invoice.status === 'draft';
  if (isDraft && mode !== 'staff') {
    throw new CustomerDocumentModeError(`a draft invoice cannot be assembled in ${mode} mode`);
  }
  // A draft previews what issuing will freeze: partner defaults resolved BEFORE
  // projection. Every issued document reads its own frozen columns.
  const detail = isDraft ? await resolveDocumentLineDetail(invoice) : customerLineDetail(invoice);
  const lines = await loadCustomerInvoiceLines(invoice, { detail, surface: opts.surface ?? 'screen' });
  const { branding, partner } = await loadBrandingAndPartner(invoice);
  return {
    invoice: { ...toCustomerInvoiceHeader(invoice), displayStatus: invoiceDisplayStatus(invoice.status) },
    lines,
    branding,
    documentLocale: invoice.documentLocale ?? resolvePartnerDocumentLocale(partner),
  };
}
