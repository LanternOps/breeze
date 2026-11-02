import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { computeQuoteTotals, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import { readQuoteImage } from './quoteImageStorage';
import { toCustomerLines, sanitizeQuoteBlocksForRead } from './quoteService';
import { loadContractPdfInputs } from './contractTemplateRender';
import { safeContentDispositionFilename } from '../utils/httpHeaders';
import { buildSellerSnapshot } from './sellerSnapshot';
import { resolveThemeId, resolvePageSize } from './documentThemes';
import { resolvePartnerDocumentLocale } from './documentLocale';
import { resolveDocumentFooter } from './documentFooter';
import { resolveDocumentBrand } from './partnerDocumentBrand';

type QuoteRow = typeof quotes.$inferSelect;

/**
 * The customer's PDF of an issued quote — the bytes behind both customer
 * Download PDF buttons: the logged-in portal (`GET /portal/quotes/:id/pdf`) and
 * the public proposal link (`GET /quotes/public/:token/pdf`, #9860). One
 * implementation so the two copies of the same proposal cannot drift.
 *
 * Contract:
 *  - The caller passes a row it ALREADY authorized (portal org guard, or the
 *    public token resolve + live-link check) and has refused drafts. This
 *    function shapes and renders; eligibility stays in the routes.
 *  - Quote rows (blocks, lines, org branding, images) are read on the CALLER's
 *    DB context — org scope for the portal, system scope for the public link.
 *    The partner row is partner-axis RLS, so it is always read under its own
 *    system context (a bare read in org scope returns 0 rows, the #1375 class).
 *  - Customer-hidden lines never reach the PDF.
 *  - Throws PdfMergeError (typed 4xx) for an unreadable uploaded contract.
 */
export async function renderCustomerQuotePdf(quote: QuoteRow): Promise<Buffer> {
  const id = quote.id;
  const blocks = sanitizeQuoteBlocksForRead(await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder));
  const lines = toCustomerLines((await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible));
  // Same totals sweep as the customer page: derive the amount due on acceptance
  // (one-time only, tax-inclusive) + per-category subtotals so the PDF's
  // "Remaining balance" line matches the page instead of falling back to
  // renderQuotePdf's oneTimeTotal default (tax-exclusive on taxed deposit quotes).
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], quote.taxRate ? parseFloat(quote.taxRate) : null, toQuoteDepositConfig(quote.depositType, quote.depositPercent), quote.currencyCode);
  const [partner] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
      name: partners.name,
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
      invoiceFooter: partners.invoiceFooter,
      currencyCode: partners.currencyCode,
      documentTheme: partners.documentTheme,
      documentPageSize: partners.documentPageSize,
      settings: partners.settings,
    }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1)
  ));
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
  const loadImage = async (imageId: string) => { const img = await readQuoteImage(imageId, id); return img ? { data: img.data } : null; };
  const { renderQuotePdf } = await import('./quotePdf');
  // Legacy docs have no frozen snapshot; synthesize from the live partner so
  // the From block still renders (issued docs use the frozen column).
  const quoteForRender = {
    ...quote,
    sellerSnapshot: quote.sellerSnapshot ?? (partner ? buildSellerSnapshot(partner) : null),
    dueOnAcceptanceTotal: totals.dueOnAcceptanceTotal,
    // Derived deposit figure — authoritative over the persisted depositAmount
    // column (selected_lines deposits derive from flagged lines).
    depositDueTotal: totals.depositDueTotal,
    categoryBreakdown: totals.categoryBreakdown,
  };
  // Snapshot-first precedence (shared with resolveQuoteBranding): a sent
  // quote's frozen presentation always wins over the partner's live
  // theme/pageSize columns.
  const presentationSnap = quote.presentationSnapshot as { theme?: string; pageSize?: string } | null;
  const branding = {
    partnerName: partner?.name ?? 'Proposal', ...resolveDocumentBrand(brand, partner?.settings),
    footer: resolveDocumentFooter({ documentTerms: quote.terms, partnerFooter: partner?.invoiceFooter ?? null, brandingFooter: brand?.footerText ?? null }), currencyCode: quote.currencyCode ?? partner?.currencyCode ?? 'USD',
    theme: resolveThemeId(presentationSnap?.theme ?? partner?.documentTheme),
    pageSize: resolvePageSize(presentationSnap?.pageSize ?? partner?.documentPageSize),
    // Send-time locale snapshot → partner language → 'en' (#3777).
    locale: quote.documentLocale ?? resolvePartnerDocumentLocale(partner),
  };
  // Substituted HTML per authored contract block, plus any uploaded contract
  // PDFs to append after rendering (pdfkit can't draw an existing PDF's pages —
  // see pdfMerge.ts). Takes quoteForRender (not the raw row) so
  // {{client.name}}/{{seller.*}} resolve from the same overlaid fields the page
  // renderer uses, and the same `branding.locale`, so contract totals and the
  // quote summary on the same PDF never disagree (#3777).
  const { contractRenderData, uploads } = await loadContractPdfInputs(blocks, quoteForRender, branding.locale);
  const pdf = await renderQuotePdf(quoteForRender, blocks, lines, loadImage, branding, undefined, contractRenderData);
  const { mergeUploadedContractPdfs } = await import('./pdfMerge');
  return mergeUploadedContractPdfs(pdf, uploads);
}

/** The download filename both customer routes use: `quote-<number|id>.pdf`, header-safe. */
export function customerQuotePdfFilename(quote: Pick<QuoteRow, 'id' | 'quoteNumber'>): string {
  return safeContentDispositionFilename(`quote-${quote.quoteNumber || quote.id}.pdf`);
}
