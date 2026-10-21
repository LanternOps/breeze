/**
 * The customer-document assembler for quotes (#9418 W2a, spec §3.4) — the
 * quote half of `customerDocument.ts`, in its own module so the invoice routes
 * that import the invoice half do not load the quote service graph. The ONLY
 * code that turns quote rows into the customer DTO: the public proposal link,
 * the logged-in portal and the staff Preview (`GET /quotes/:id/customer-view`)
 * all return its output, so who-sees-what has one implementation.
 *
 * Contract (shared with the invoice half):
 *  - The caller passes the row it ALREADY authorized (public token resolve +
 *    live-link check, portal org guard, staff `getAccessibleQuoteRow`).
 *    Eligibility stays in the routes; this module shapes data.
 *  - Hidden lines (`customer_visible = false`) never leave, in any mode: the
 *    line query filters them in SQL.
 *  - The header keyset is the public link's (`toCustomerQuoteHeaderFields`) in
 *    every mode; only the status differs by mode.
 */
import { and, eq } from 'drizzle-orm';
import type {
  CustomerDocumentMode, CustomerQuoteBlockDto, CustomerQuoteBrandingDto, CustomerQuoteDisplayStatus,
  CustomerQuoteDocument, CustomerQuoteHeaderDto, CustomerQuoteLineDto,
} from '@breeze/shared/documents';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import { portalBranding } from '../db/schema/portal';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import { CustomerDocumentModeError, OD9_CUSTOMER_PROJECTION, type DocumentSurface, type Od9Projection } from './customerDocument';
import { attachCustomerLineImages, sanitizeQuoteBlocksForRead, toCustomerLines } from './quoteService';
import { renderContractBlocksForClient } from './contractTemplateRender';
import { computeQuoteTotals, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import { toCustomerQuoteHeaderFields, toPublicQuoteStatus, withQuoteStatus } from './publicQuoteDto';
import { resolveDocumentBrand } from './partnerDocumentBrand';
import { resolvePageSize, resolveThemeId } from './documentThemes';
import { resolvePartnerDocumentLocale } from './documentLocale';
import { buildSellerSnapshot } from './sellerSnapshot';

export { CustomerDocumentModeError } from './customerDocument';
export type { CustomerDocumentMode } from '@breeze/shared/documents';

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
