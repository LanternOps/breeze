import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { quotes, quoteBlocks, quoteLines } from '../../db/schema/quotes';
import { partners } from '../../db/schema/orgs';
import { portalBranding } from '../../db/schema/portal';
import { acceptQuoteSchema, declineQuoteSchema } from '@breeze/shared';
import { markQuoteViewed, declineQuoteByActor } from '../../services/quoteLifecycle';
import { acceptQuote, emitAcceptInvoiceIssued } from '../../services/quoteAcceptService';
import { createQuotePayLink } from '../../services/quotePay';
import { computeQuoteTotals, toQuoteDepositConfig, type QuoteLineForMath } from '../../services/quoteMath';
import { readQuoteImage } from '../../services/quoteImageStorage';
import { QuoteServiceError } from '../../services/quoteTypes';
import { toCustomerLines, sanitizeQuoteBlocksForRead } from '../../services/quoteService';
import { loadContractBlockRenderData, renderContractBlocksForClient, loadContractPdfInputs } from '../../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';
import { PdfMergeError } from '../../services/pdfMerge';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { buildSellerSnapshot } from '../../services/sellerSnapshot';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const quoteRoutes = new Hono();
const idParam = z.object({ id: z.string().guid() });
const imageParam = z.object({ id: z.string().guid(), imageId: z.string().guid() });
const blockFileParam = z.object({ id: z.string().guid(), blockId: z.string().guid() });

// GET /quotes — list (drafts filtered; org defense-in-depth atop RLS).
quoteRoutes.get('/quotes', async (c) => {
  const auth = c.get('portalAuth');
  const conditions = and(eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'));
  const data = await db.select({
    id: quotes.id, quoteNumber: quotes.quoteNumber, status: quotes.status, currencyCode: quotes.currencyCode,
    issueDate: quotes.issueDate, expiryDate: quotes.expiryDate, total: quotes.total,
  }).from(quotes).where(conditions).orderBy(desc(quotes.issueDate), desc(quotes.createdAt)).limit(200);
  return c.json({ data, pagination: { page: 1, limit: 200, total: data.length } });
});

// GET /quotes/:id — detail (+ blocks + customer-visible lines). Stamps viewed.
quoteRoutes.get('/quotes/:id', zValidator('param', idParam), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId))).limit(1);
  if (!quote || quote.status === 'draft') return c.json({ error: 'Quote not found' }, 404);
  const rawBlocks = sanitizeQuoteBlocksForRead(await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder));
  const lines = toCustomerLines((await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible));
  try { await markQuoteViewed(id, auth.user.orgId); } catch (err) { console.error('[portal] quote markViewed failed', { id, err }); }
  // Derive the amount accept actually invoices (one-time only) so the customer
  // sees an accurate "due on acceptance" instead of the recurring-inclusive total,
  // plus the deposit due + per-category subtotals for the summary panel.
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], quote.taxRate ? parseFloat(quote.taxRate) : null, toQuoteDepositConfig(quote.depositType, quote.depositPercent));
  // Branding parity with the public token view (quotesPublic.ts): partners is a
  // partner-axis RLS table invisible to this org scope (#1375 class — 0 rows, no
  // error), so the name reads under SYSTEM scope like the /pdf route below;
  // portal_branding is org-scoped and reads fine here.
  const [partner] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1)));
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
  try {
    // Resolves every `contract` block's pinned template version (system context,
    // ahead of the response we're about to build below) and replaces its raw
    // authoring content with the render contract the portal understands.
    const blocks = await renderContractBlocksForClient(rawBlocks, quote, (blockId) => `/portal/quotes/${id}/contract-file/${blockId}`);
    return c.json({ data: { quote: { ...quote, dueOnAcceptanceTotal: totals.dueOnAcceptanceTotal, depositDueTotal: totals.depositDueTotal, categoryBreakdown: totals.categoryBreakdown }, blocks, lines, branding: { partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null } } });
  } catch (err) {
    if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// GET /quotes/:id/pdf
quoteRoutes.get('/quotes/:id/pdf', zValidator('param', idParam), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  try {
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId))).limit(1);
  if (!quote || quote.status === 'draft') return c.json({ error: 'Quote not found' }, 404);
  const blocks = sanitizeQuoteBlocksForRead(await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder));
  const lines = toCustomerLines((await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible));
  // Same totals sweep as GET /quotes/:id: derive the amount due on acceptance
  // (one-time only, tax-inclusive) + per-category subtotals so the PDF's
  // "Remaining balance" line matches the portal detail view instead of falling
  // back to renderQuotePdf's oneTimeTotal default (tax-exclusive on taxed
  // deposit quotes).
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], quote.taxRate ? parseFloat(quote.taxRate) : null, toQuoteDepositConfig(quote.depositType, quote.depositPercent));
  // partners is a partner-axis RLS table — the portal request runs in ORG scope,
  // where breeze_has_partner_access is false. A bare read returns 0 rows with NO
  // error (the #1375 class), causing buildSellerSnapshot(undefined) to produce an
  // all-null From block on legacy quotes whose seller_snapshot is NULL. Read under
  // SYSTEM scope, exactly like the sibling portal/invoices.ts pay/settle paths do.
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
    }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1)
  ));
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
  const loadImage = async (imageId: string) => { const img = await readQuoteImage(imageId, id); return img ? { data: img.data } : null; };
  // Pre-fetch the same render data Task 13's portal detail route uses
  // (system-context read of pinned template versions) and shape it for the
  // renderer: substituted HTML per authored contract block, plus any uploaded
  // contract PDFs to append after rendering (pdfkit can't draw an existing
  // PDF's pages — see pdfMerge.ts).
  const { contractRenderData, uploads } = await loadContractPdfInputs(blocks, quote);
  const { renderQuotePdf } = await import('../../services/quotePdf');
  // Legacy/draft docs have no frozen snapshot; synthesize from the live partner so
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
  const pdf = await renderQuotePdf(quoteForRender, blocks, lines, loadImage, {
    partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
    footer: quote.terms ?? partner?.invoiceFooter ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? partner?.currencyCode ?? 'USD',
  }, undefined, contractRenderData);
  const { mergeUploadedContractPdfs } = await import('../../services/pdfMerge');
  const finalPdf = await mergeUploadedContractPdfs(pdf, uploads);
  const filename = safeContentDispositionFilename(`quote-${quote.quoteNumber || quote.id}.pdf`);
  return new Response(new Uint8Array(finalPdf), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Content-Length': String(finalPdf.length) } });
  } catch (err) {
    // A legacy encrypted/corrupt uploaded contract PDF surfaces as a typed 4xx here
    // (matching the admin route's handleServiceError) instead of an uncaught 500.
    if (err instanceof PdfMergeError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// GET /quotes/:id/images/:imageId
quoteRoutes.get('/quotes/:id/images/:imageId', zValidator('param', imageParam), async (c) => {
  const auth = c.get('portalAuth'); const { id, imageId } = c.req.valid('param');
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  const img = await readQuoteImage(imageId, id);
  if (!img) return c.json({ error: 'Image not found' }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// GET /quotes/:id/contract-file/:blockId — uploaded contract PDF bytes, mirroring
// the /quotes/:id/images/:imageId asset route. eq(quoteBlocks.quoteId, id) closes
// the same-org cross-quote case (a contract block belonging to a different quote
// in this org 404s here, same as a cross-quote image id).
quoteRoutes.get('/quotes/:id/contract-file/:blockId', zValidator('param', blockFileParam), async (c) => {
  const auth = c.get('portalAuth'); const { id, blockId } = c.req.valid('param');
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  const [block] = await db.select().from(quoteBlocks).where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, id), eq(quoteBlocks.blockType, 'contract'))).limit(1);
  if (!block) return c.json({ error: 'Contract file not found' }, 404);
  const [renderData] = await loadContractBlockRenderData([block], { includeFileData: true });
  if (!renderData || renderData.sourceType !== 'uploaded' || !renderData.fileData) return c.json({ error: 'Contract file not found' }, 404);
  return new Response(new Uint8Array(renderData.fileData), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(renderData.fileData.length), 'Cache-Control': 'private, max-age=300' } });
});

// POST /quotes/:id/accept — signer types their full name (electronic signature)
// in the portal's signature panel; we record it as signerName. Falls back to the
// authenticated identity if the body omits it (older clients).
quoteRoutes.post('/quotes/:id/accept', zValidator('param', idParam), zValidator('json', acceptQuoteSchema.partial()), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const signerName = c.req.valid('json').signerName?.trim() || auth.user.name || auth.user.email;
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  try {
    // Pre-fetch the contract-block render data BEFORE the accept transaction:
    // loadContractBlockRenderData resolves the pinned template versions under a
    // SYSTEM context (the dual-axis template rows are invisible to this org scope),
    // and the executed-document snapshot must read immutable version content from
    // outside the org-scoped accept transaction. acceptQuote's guard hard-fails if
    // any contract block is missing from this set.
    const blocks = await db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType, content: quoteBlocks.content })
      .from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
    const contractRenderData = await loadContractBlockRenderData(blocks, { includeFileData: true });
    // Run in a system sub-context: acceptQuote now auto-issues the converted
    // invoice, which writes the partner-axis partner_invoice_sequences counter.
    // This portal context is org-scoped with NO partner access (auth.ts:
    // accessiblePartnerIds: []), so a bare call would hit an RLS WITH CHECK
    // violation on that insert (#1375 class) and roll the whole accept back.
    // Org ownership is already verified by the org-scoped lookup above. The
    // public path (quotesPublic.ts) wraps acceptQuote the same way.
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptQuote({
      quoteId: id, signerName, signerEmail: auth.user.email,
      ipAddress: getTrustedClientIpOrUndefined(c) ?? null, userAgent: c.req.header('user-agent') ?? null, actorUserId: null,
      contractRenderData,
    })));
    // Post-commit (outside the DB context): emit invoice.issued + enqueue the PDF
    // render, matching invoiceService.issueInvoice. Fire-and-forget; never fails the
    // accept the customer already completed.
    await emitAcceptInvoiceIssued(res, auth.user.id);
    return c.json({ data: { invoiceId: res.invoiceId, status: res.quote.status, pax8OrderId: res.pax8OrderId } });
  } catch (err) {
    if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    // loadContractBlockRenderData throws this when a contract block references a
    // missing/mismatched template version (404 VERSION_NOT_FOUND).
    if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// POST /quotes/:id/decline
quoteRoutes.post('/quotes/:id/decline', zValidator('param', idParam), zValidator('json', declineQuoteSchema), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param'); const { reason } = c.req.valid('json');
  // Route through declineQuoteByActor so the portal shares the same status +
  // read-time expiry (410) guards as the public/internal decline paths — an
  // inline update here previously let an authed portal user decline an
  // expired-but-not-yet-swept quote, diverging from "expired is terminal".
  try {
    const updated = await declineQuoteByActor(id, reason ?? undefined, { userId: auth.user.id, partnerId: null, accessibleOrgIds: [auth.user.orgId] });
    return c.json({ data: { status: updated.status } });
  } catch (err) {
    if (err instanceof QuoteServiceError) {
      // getQuote throws 404 QUOTE_NOT_FOUND / 403 ORG_DENIED for a non-owned id.
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    throw err;
  }
});

// POST /quotes/:id/pay — mint a Stripe checkout link for an accepted (converted)
// quote's invoice. Runs in a system sub-context: createQuotePayLink →
// createInvoicePayLink reads the partner-axis stripe connection, which this org
// scope would RLS-filter to 0 rows (#1375). Org access stays enforced by the
// org-scoped quote lookup below + the actor's accessibleOrgIds.
quoteRoutes.post('/quotes/:id/pay', zValidator('param', idParam), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  try {
    const link = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      createQuotePayLink(id, { userId: null, partnerId: null, accessibleOrgIds: [auth.user.orgId] })));
    return c.json({ data: { url: link.url } });
  } catch (err) {
    if (err instanceof QuoteServiceError || err instanceof InvoiceServiceError) {
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    throw err;
  }
});
