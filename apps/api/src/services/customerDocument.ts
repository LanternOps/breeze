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
import { invoiceLines, partners, tickets } from '../db/schema';
import { portalBranding } from '../db/schema/portal';
import {
  customerLineDetail, resolveDocumentLineDetail, toCustomerInvoiceHeader, toCustomerInvoiceLine, type InvoiceRow,
} from './invoiceService';
import { captureException } from './sentry';
import { invoiceLineTicketCategorySql, invoiceLineTicketNumberSql, invoiceLineTicketSubjectSql } from './invoiceRenderHelpers';
import { resolveInvoicePresentation } from './invoicePresentation';
import { resolvePartnerDocumentLocale } from './documentLocale';
// ---- W2a (#9418): quote document ----
import type {
  CustomerQuoteBlockDto, CustomerQuoteBrandingDto, CustomerQuoteDisplayStatus, CustomerQuoteDocument,
  CustomerQuoteHeaderDto, CustomerQuoteLineDto,
} from '@breeze/shared/documents';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import { attachCustomerLineImages, sanitizeQuoteBlocksForRead, toCustomerLines } from './quoteService';
import { renderContractBlocksForClient } from './contractTemplateRender';
import { computeQuoteTotals, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import { toCustomerQuoteHeaderFields, toPublicQuoteStatus, withQuoteStatus } from './publicQuoteDto';
import { resolveDocumentBrand } from './partnerDocumentBrand';
import { resolvePageSize, resolveThemeId } from './documentThemes';
import { buildSellerSnapshot } from './sellerSnapshot';

export type { CustomerDocumentMode } from '@breeze/shared/documents';
export type { InvoiceRow } from './invoiceService';
export type DocumentSurface = 'screen' | 'pdf';
export type Od9Projection = Readonly<Record<DocumentSurface, Readonly<{ ticketSubject: boolean; bundleNesting: boolean }>>>;

/** OD-9 (#9402) — pending Todd. Flip the line for a surface when the ruling lands.
 *  The projection itself carries or withholds the data, so a withheld field is
 *  never on the wire (a builder-only flag would leave it there). Frozen: it gates
 *  what leaves the server, so nothing may flip it at runtime. */
export const OD9_CUSTOMER_PROJECTION: Od9Projection = Object.freeze({
  screen: Object.freeze({ ticketSubject: false, bundleNesting: false }), // web Preview + portal public + portal logged-in (W1 invoices, W2 quotes)
  pdf:    Object.freeze({ ticketSubject: true,  bundleNesting: false }), // invoicePdf/quotePdf via the assembler (W3); keeps today's PDF subject
});

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
  /** `projection` defaults to OD9_CUSTOMER_PROJECTION; overridable only so tests can drive both branches.
   *  `locale` is the document locale (it labels the generic labor line); it defaults to the invoice's
   *  stamped locale, then 'en' — the assembler passes the partner-resolved locale for an unstamped draft. */
  opts: { detail: InvoiceLineDetail; surface: DocumentSurface; projection?: Od9Projection; locale?: string },
): Promise<CustomerInvoiceLineDto[]> {
  const rows = await queryCustomerInvoiceLineRows(invoice);
  return projectCustomerInvoiceLines(rows, { ...opts, locale: opts.locale ?? invoice.documentLocale ?? 'en' });
}

/** The line query alone (visibility filter in SQL, tickets joined in the invoice's org). */
async function queryCustomerInvoiceLineRows(invoice: InvoiceRow) {
  return db.select({
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
}

/** A line row as the customer line query selects it. */
export type CustomerInvoiceLineQueryRow = Parameters<typeof toCustomerInvoiceLine>[0] & { parentLineId?: string | null };

/**
 * PURE: the customer projection of already-filtered (customer-visible) line
 * rows — `toCustomerInvoiceLine` (the #8604 boundary) plus the OD-9 keys when
 * the surface's switch is on. The DB-free invoice PDF entry point
 * (`renderInvoicePdfBuffer`) calls the same function as the assembler, so the
 * PDF and the screens cannot project differently.
 */
export function projectCustomerInvoiceLines(
  rows: readonly CustomerInvoiceLineQueryRow[],
  opts: { detail: InvoiceLineDetail; surface: DocumentSurface; projection?: Od9Projection; locale?: string },
): CustomerInvoiceLineDto[] {
  const flags = (opts.projection ?? OD9_CUSTOMER_PROJECTION)[opts.surface];
  const locale = opts.locale ?? 'en';
  return rows.map((r) => {
    const line: CustomerInvoiceLineDto = toCustomerInvoiceLine(r, opts.detail, locale);
    if (flags.ticketSubject) line.ticketSubject = r.ticketSubject ?? null;
    if (flags.bundleNesting) line.isChild = r.parentLineId != null;
    return line;
  });
}

export type DocumentPartner = {
  name: string | null;
  billingEmail: string | null;
  documentTheme: string | null;
  documentPageSize: string | null;
  settings: unknown;
};

/** Log AND report a fail-soft read: the document still renders, but a DB outage
 *  that blanks every customer's branding must reach Sentry, not just stdout. */
function reportSoftFailure(what: 'partner' | 'branding', invoice: InvoiceRow, err: unknown): void {
  console.error(`[customerDocument] ${what} lookup failed`, { invoiceId: invoice.id, err });
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
    phase: `customer_document_${what}`, invoice_id: invoice.id,
  });
}

/**
 * Branding plus the partner row it was read from (shared with the locale chain).
 *
 * Both reads run in their OWN system context, keyed on the already-authorized
 * invoice row's partnerId / orgId:
 *  - `partners` is partner-axis RLS — invisible to an org-scoped portal caller
 *    (#1375 class: 0 rows, no error);
 *  - neither read may run on the caller's transaction: these reads are
 *    fail-soft, and a swallowed error inside the request transaction would leave
 *    it aborted (25P02) for every query after it.
 * Each read fails soft on its own, as the portal always did — branding is
 * decoration on a document the customer came to read or pay — so a branding
 * failure keeps the partner name and locale, and vice versa.
 */
async function loadBrandingAndPartner(
  invoice: InvoiceRow,
): Promise<{ branding: CustomerDocumentBrandingDto; partner: DocumentPartner | null }> {
  let partner: DocumentPartner | null = null;
  try {
    const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({
        name: partners.name,
        billingEmail: partners.billingEmail,
        documentTheme: partners.documentTheme,
        documentPageSize: partners.documentPageSize,
        settings: partners.settings,
      }).from(partners).where(eq(partners.id, invoice.partnerId)).limit(1)));
    partner = row ?? null;
  } catch (err) {
    reportSoftFailure('partner', invoice, err);
  }

  let brand: { logoUrl: string | null; primaryColor: string | null } | null = null;
  try {
    const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
        .from(portalBranding)
        .where(eq(portalBranding.orgId, invoice.orgId))
        .limit(1)));
    brand = row ?? null;
  } catch (err) {
    reportSoftFailure('branding', invoice, err);
  }

  return { partner, branding: composeBranding(invoice, partner, brand) };
}

/** Branding the caller has ALREADY read (strictly, on its own connection). */
export interface PreloadedBranding {
  partner: DocumentPartner | null;
  brand: { logoUrl: string | null; primaryColor: string | null } | null;
}

function composeBranding(
  invoice: InvoiceRow, partner: DocumentPartner | null, brand: PreloadedBranding['brand'],
): CustomerDocumentBrandingDto {
  return {
    partnerName: partner?.name ?? null,
    contactEmail: partner?.billingEmail ?? null,
    logoUrl: brand?.logoUrl ?? null,
    primaryColor: brand?.primaryColor ?? null,
    // #6227: the invoice's issue-time snapshot; partner live values only for a draft.
    ...resolveInvoicePresentation(invoice, partner),
  };
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
  /** `preloaded`: a caller that already holds an open transaction (the PDF render) passes the
   *  branding it read on that connection. The default reads open their OWN system context,
   *  i.e. a second connection — inside an open transaction that queues behind any pending
   *  ACCESS EXCLUSIVE lock request and the outer transaction then waits on it forever. */
  opts: { surface?: DocumentSurface; preloaded?: PreloadedBranding } = {},
): Promise<CustomerInvoiceDocument> {
  const isDraft = invoice.status === 'draft';
  if (isDraft && mode !== 'staff') {
    throw new CustomerDocumentModeError(`a draft invoice cannot be assembled in ${mode} mode`);
  }
  // A draft previews what issuing will freeze: partner defaults resolved BEFORE
  // projection. Every issued document reads its own frozen columns.
  const detail = isDraft ? await resolveDocumentLineDetail(invoice) : customerLineDetail(invoice);
  const rows = await queryCustomerInvoiceLineRows(invoice);
  const partner = opts.preloaded ? opts.preloaded.partner : null;
  const { branding, partner: resolvedPartner } = opts.preloaded
    ? { branding: composeBranding(invoice, partner, opts.preloaded.brand), partner }
    : await loadBrandingAndPartner(invoice);
  // The stamped locale, else the partner's language (spec §3.7) — also the
  // language of the generic labor line, so an unstamped draft reads like the
  // document it will become.
  const documentLocale = invoice.documentLocale ?? resolvePartnerDocumentLocale(resolvedPartner);
  const lines = projectCustomerInvoiceLines(rows, { detail, surface: opts.surface ?? 'screen', locale: documentLocale });
  return {
    invoice: {
      ...toCustomerInvoiceHeader(invoice),
      // The grouping the lines were projected with: for a draft, the partner
      // default issuing will freeze; for an issued document, its frozen column.
      lineGrouping: detail.grouping,
      displayStatus: invoiceDisplayStatus(invoice.status),
    },
    lines,
    branding,
    documentLocale,
  };
}

// ===========================================================================
// W2a (#9418): the quote document.
//
// Same contract as the invoice half: the caller passes the row it ALREADY
// authorized (public token resolve + live-link check, portal org guard, staff
// getAccessibleQuoteRow); eligibility stays in the routes. Hidden lines never
// leave — the line query filters them in SQL. The header keyset is the public
// link's (`toCustomerQuoteHeaderFields`) in every mode; only the status differs.
// ===========================================================================

export type QuoteRow = typeof quotes.$inferSelect;

/** Host-specific asset URLs. The routes own their URL schemes (token path,
 *  portal path, staff path); the assembler never invents one. */
export interface CustomerQuoteAssetPaths {
  lineImage(line: { id: string; imageId: string | null; catalogItemId: string | null }): string;
  contractFile(blockId: string): string;
}

/** The pill the customer's public link would show: `sent` reads as `viewed`
 *  (the public mapping); a draft has none. */
export function quoteDisplayStatus(status: QuoteRow['status']): CustomerQuoteDisplayStatus | null {
  if (status === 'draft') return null;
  return status === 'sent' ? 'viewed' : status;
}

type QuoteBlockRow = typeof quoteBlocks.$inferSelect;

/**
 * The single customer row queries for a quote, on the CALLER's context (system
 * for the public link, org for the portal, partner for staff): the quote's own
 * blocks and its customer-visible lines, both within the quote's org. Blocks
 * pass the read sanitizer; lines pass the customer allowlist
 * (`toCustomerLines`), which still carries the image source ids the asset
 * paths need.
 */
export async function loadCustomerQuoteRows(quote: QuoteRow) {
  const blocks = sanitizeQuoteBlocksForRead(
    await db.select().from(quoteBlocks)
      .where(and(eq(quoteBlocks.quoteId, quote.id), eq(quoteBlocks.orgId, quote.orgId)))
      .orderBy(quoteBlocks.sortOrder),
  );
  const lines = toCustomerLines(
    await db.select().from(quoteLines)
      .where(and(
        eq(quoteLines.quoteId, quote.id),
        eq(quoteLines.orgId, quote.orgId),
        eq(quoteLines.customerVisible, true),
      ))
      .orderBy(quoteLines.sortOrder),
  );
  return { blocks, lines };
}

/**
 * Partner and org branding, each in its OWN system context keyed on the
 * authorized row (partners is partner-axis RLS — 0 rows for an org-scoped
 * portal caller, the #1375 class). Fail closed, as both quote routes were
 * before the assembler: a thrown read is a 500, never a document with a
 * silently-wrong locale. The partner's billing columns are the seller fields
 * a draft's Preview resolves (what sending will freeze).
 */
async function loadQuotePartnerAndBrand(quote: QuoteRow) {
  const [partner] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
      name: partners.name,
      settings: partners.settings,
      documentTheme: partners.documentTheme,
      documentPageSize: partners.documentPageSize,
      billingCompanyName: partners.billingCompanyName,
      billingEmail: partners.billingEmail,
      billingPhone: partners.billingPhone,
      billingWebsite: partners.billingWebsite,
      billingAddressLine1: partners.billingAddressLine1,
      billingAddressLine2: partners.billingAddressLine2,
      billingAddressCity: partners.billingAddressCity,
      billingAddressRegion: partners.billingAddressRegion,
      billingAddressPostalCode: partners.billingAddressPostalCode,
      billingAddressCountry: partners.billingAddressCountry,
    }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1)));
  const [brand] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
      logoUrl: portalBranding.logoUrl,
      primaryColor: portalBranding.primaryColor,
      supportEmail: portalBranding.supportEmail,
      supportPhone: portalBranding.supportPhone,
    }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1)));
  return { partner: partner ?? null, brand: brand ?? null };
}

const isoOf = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v);

/**
 * THE `SanitizedHtml` cast for quotes (spec §3.2). Every HTML field in these
 * blocks has passed the server sanitizer: rich_text/table/callout through
 * `sanitizeQuoteBlocksForRead`, contract `renderedHtml` through
 * `renderContractBlocksForClient` (sanitized template output with HTML-escaped
 * substitutions). Only this function asserts that to the type system.
 */
function asCustomerQuoteBlocks(blocks: QuoteBlockRow[]): CustomerQuoteBlockDto[] {
  return blocks.map((b) => ({ ...b, createdAt: isoOf(b.createdAt) })) as unknown as CustomerQuoteBlockDto[];
}

/**
 * Assemble the customer quote document for an already-authorized row.
 *
 * Modes (spec §3.4): `public` keeps the public link's status mapping and its
 * refusals (a draft, and 410 QUOTE_SUPERSEDED); `portal` keeps the raw status
 * and serves a superseded quote (the "Replaced" notice); `staff` accepts any
 * status, and for a draft resolves the seller sending will freeze. Every mode
 * emits `displayStatus`.
 */
export async function assembleCustomerQuoteDocument(
  quote: QuoteRow,
  mode: CustomerDocumentMode,
  opts: { assets: CustomerQuoteAssetPaths; surface?: DocumentSurface; projection?: Od9Projection },
): Promise<CustomerQuoteDocument> {
  const isDraft = quote.status === 'draft';
  if (isDraft && mode !== 'staff') {
    throw new CustomerDocumentModeError(`a draft quote cannot be assembled in ${mode} mode`);
  }
  // Refuse before any read: the public mapping throws a 410 for a superseded quote.
  const status: CustomerQuoteHeaderDto['status'] = mode === 'public' ? toPublicQuoteStatus(quote.status) : quote.status;

  const { blocks: rawBlocks, lines } = await loadCustomerQuoteRows(quote);
  const { partner, brand } = await loadQuotePartnerAndBrand(quote);

  // A staff draft previews what sending freezes (quoteLifecycle send:
  // `quote.sellerSnapshot ?? buildSellerSnapshot(partner)`). Issued quotes read
  // their own frozen snapshot in every mode.
  const row: QuoteRow = isDraft && quote.sellerSnapshot == null && partner
    ? { ...quote, sellerSnapshot: buildSellerSnapshot(partner) }
    : quote;

  const documentLocale = quote.documentLocale ?? resolvePartnerDocumentLocale(partner);
  const rendered = await renderContractBlocksForClient(rawBlocks, row, opts.assets.contractFile, documentLocale);

  const totals = computeQuoteTotals(
    lines as QuoteLineForMath[],
    quote.taxRate ? parseFloat(quote.taxRate) : null,
    toQuoteDepositConfig(quote.depositType, quote.depositPercent),
    quote.currencyCode,
  );

  const sources = new Map(lines.map((l) => [l.id, { id: l.id, imageId: l.imageId ?? null, catalogItemId: l.catalogItemId ?? null }]));
  const flags = (opts.projection ?? OD9_CUSTOMER_PROJECTION)[opts.surface ?? 'screen'];
  const customerLines = attachCustomerLineImages(lines, (lineId) => opts.assets.lineImage(sources.get(lineId)!))
    .map((l) => {
      const line = { ...l, createdAt: isoOf(l.createdAt) } as CustomerQuoteLineDto;
      if (flags.bundleNesting) line.isChild = l.parentLineId != null;
      return line;
    });

  // Snapshot-first precedence (shared with resolveQuoteBranding): a sent
  // quote's frozen presentation always wins over the partner's live columns.
  const snap = quote.presentationSnapshot as { theme?: string; pageSize?: string } | null;
  const branding: CustomerQuoteBrandingDto = {
    partnerName: partner?.name ?? null,
    ...resolveDocumentBrand(brand ?? undefined, partner?.settings),
    supportEmail: brand?.supportEmail ?? null,
    supportPhone: brand?.supportPhone ?? null,
    theme: resolveThemeId(snap?.theme ?? partner?.documentTheme),
    pageSize: resolvePageSize(snap?.pageSize ?? partner?.documentPageSize),
  };

  return {
    quote: { ...withQuoteStatus(toCustomerQuoteHeaderFields(row, totals), status), displayStatus: quoteDisplayStatus(quote.status) },
    blocks: asCustomerQuoteBlocks(rendered),
    lines: customerLines,
    branding,
    documentLocale,
  };
}
