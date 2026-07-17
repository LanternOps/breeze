import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createQuoteSchema, cloneQuoteSchema, updateQuoteSchema, quoteLineInputSchema, catalogQuoteLineSchema,
  updateQuoteLineSchema, quoteBlockInputSchema, listQuotesQuerySchema,
  reorderBlocksSchema, reorderLinesSchema, moveQuoteLineSchema, type CloneQuoteInput,
} from '@breeze/shared';
import {
  createQuote, cloneQuote, getQuote, listQuotes, updateQuote, deleteDraftQuote,
  addManualLine, addCatalogLine, updateLine, removeLine, addBlock, updateBlock, deleteBlock,
  reorderBlocks, reorderLines, moveLineToBlock,
} from '../../services/quoteService';
import { QuoteServiceError, type QuoteActor } from '../../services/quoteTypes';
import { db } from '../../db';
import { quoteImages } from '../../db/schema/quotes';
import { readCatalogItemImage } from '../../services/catalogImageStorage';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { resolveQuoteBranding } from '../../services/quoteBranding';
import {
  renderContractBlocksForClient,
  loadContractPdfInputs,
  loadContractBlockAuthoring,
  attachContractAuthoring,
} from '../../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';
import { PdfMergeError } from '../../services/pdfMerge';

export const quoteCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });
const blockParam = z.object({ id: z.string().guid(), blockId: z.string().guid() });

export function quoteActorFrom(c: { get: (k: string) => unknown }): QuoteActor {
  const auth = c.get('auth') as AuthContext;
  // These routes require partner/system scope, where allowedSiteIds is undefined
  // (unrestricted) — threading it is a no-op today but keeps the actor honest if an
  // org/site-scoped token is ever admitted here.
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds, allowedSiteIds: auth.allowedSiteIds };
}
export function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  // An unloadable/encrypted uploaded contract PDF surfaces as a 4xx (typed) here
  // rather than an uncaught 500 — uploads are validated at write time, so this is
  // the defense-in-depth backstop for a legacy row.
  if (err instanceof PdfMergeError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

quoteCrudRoutes.get('/', scopes, readPerm, zValidator('query', listQuotesQuerySchema), async (c) => {
  try { return c.json({ data: await listQuotes(c.req.valid('query'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/', scopes, writePerm, zValidator('json', createQuoteSchema), async (c) => {
  try { return c.json({ data: await createQuote(c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/:id/clone', scopes, writePerm, zValidator('param', idParam), async (c) => {
  // Optional retarget/rename body. Distinguish an ABSENT body (legacy callers
  // POST nothing) from a PRESENT-but-broken one: an empty body degrades to a
  // plain same-org clone; ANY non-empty body that fails to read, parse, or
  // validate is a 400 — never a silent same-org clone of a retarget the caller
  // intended. Read unconditionally (no content-type gate): a JSON body sent
  // without the header must still be honored, and a non-JSON body must 400.
  let input: CloneQuoteInput = {};
  let raw: string;
  try { raw = await c.req.text(); } catch { return c.json({ error: 'Failed to read request body' }, 400); }
  if (raw.trim()) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
    const parsed = cloneQuoteSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: 'Invalid clone options' }, 400);
    input = parsed.data;
  }
  try { return c.json({ data: await cloneQuote(c.req.valid('param').id, quoteActorFrom(c), input) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const detail = await getQuote(id, quoteActorFrom(c));
    // Branding lets the in-app Preview render the customer-facing document
    // (logo, accent, seller, footer) without a second round-trip — same object
    // the PDF route builds, so the preview matches what the customer receives.
    const branding = await resolveQuoteBranding(detail.quote);
    // Resolves every `contract` block's pinned template version (system context)
    // and replaces its raw authoring content with the render contract the
    // in-app Preview (web QuoteDocument.tsx) understands — same contract portal
    // and public serve, so the editor preview matches what the customer sees.
    const blocks = await renderContractBlocksForClient(detail.blocks, detail.quote, (blockId) => `/quotes/${id}/contract-file/${blockId}`);
    // ADMIN-ONLY: attach the raw authoring fields (templateId/templateVersionId/
    // variableValues + the pinned version's declaredVariables + latest-published
    // nudge target) so the editor can render the manual-variable form and offer an
    // explicit version-update action. This is the ONLY route that does this — the
    // portal + public serves deliberately expose the stripped display shape only
    // (tenant-facing boundary; see loadContractBlockAuthoring's doc comment).
    // attachContractAuthoring builds the ContractAdminBlockContent shape
    // (ContractClientBlockContent + optional `authoring`) explicitly — the
    // portal/public routes never call it, so their block content can never
    // carry `authoring`.
    const authoring = await loadContractBlockAuthoring(detail.blocks);
    const blocksForEditor = attachContractAuthoring(blocks, authoring);
    return c.json({ data: { ...detail, blocks: blocksForEditor, branding } });
  } catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateQuoteSchema), async (c) => {
  try { return c.json({ data: await updateQuote(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { await deleteDraftQuote(c.req.valid('param').id, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/:id/blocks', scopes, writePerm, zValidator('param', idParam), zValidator('json', quoteBlockInputSchema), async (c) => {
  try { return c.json({ data: await addBlock(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/blocks/reorder', scopes, writePerm, zValidator('param', idParam), zValidator('json', reorderBlocksSchema), async (c) => {
  try { const { id } = c.req.valid('param'); await reorderBlocks(id, c.req.valid('json').blockIds, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/blocks/:blockId', scopes, writePerm, zValidator('param', blockParam), zValidator('json', quoteBlockInputSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await updateBlock(p.id, p.blockId, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/blocks/:blockId/lines/reorder', scopes, writePerm, zValidator('param', blockParam), zValidator('json', reorderLinesSchema), async (c) => {
  try { const { id, blockId } = c.req.valid('param'); await reorderLines(id, blockId, c.req.valid('json').lineIds, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.delete('/:id/blocks/:blockId', scopes, writePerm, zValidator('param', blockParam), async (c) => {
  try { const p = c.req.valid('param'); await deleteBlock(p.id, p.blockId, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', quoteLineInputSchema), async (c) => {
  try { return c.json({ data: await addManualLine(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/:id/lines/catalog', scopes, writePerm, zValidator('param', idParam), zValidator('json', catalogQuoteLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addCatalogLine(c.req.valid('param').id, b.catalogItemId, b.quantity, b.blockId, quoteActorFrom(c), { partNumber: b.partNumber ?? null }) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), zValidator('json', updateQuoteLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await updateLine(p.id, p.lineId, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/lines/:lineId/move', scopes, writePerm, zValidator('param', lineParam), zValidator('json', moveQuoteLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await moveLineToBlock(p.id, p.lineId, c.req.valid('json').blockId, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try { const p = c.req.valid('param'); await removeLine(p.id, p.lineId, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});

// GET /:id/pdf — render the proposal PDF (blocks in order) and stream it inline.
// getQuote() enforces the org-access guard (404 cross-tenant). Image bytes are
// loaded from quote_images under the request's RLS context (org-scoped rows, so
// the bare `db` is correct here — same pattern the service uses to read its
// tables). Branding resolves like invoicePdf: partner name + portal logo/color +
// partner invoice footer/currency. Footer precedence is
// quote.terms ?? partner invoice footer ?? portal footer text.
quoteCrudRoutes.get('/:id/pdf', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const { quote, blocks, lines, billTo } = await getQuote(id, quoteActorFrom(c));

    const branding = await resolveQuoteBranding(quote);

    const quoteForRender = {
      ...quote,
      // Legacy/draft docs have no frozen snapshot; resolveQuoteBranding synthesizes
      // one from the live partner so the From block still renders.
      sellerSnapshot: branding.seller,
      // Overlay the resolved customer bill-to so a DRAFT (whose billTo* columns are
      // still null) renders the org's billing address in the "Prepared for" block,
      // matching what the customer will get once sent. Falls back to the quote's
      // own frozen fields if a caller supplies no resolved billTo.
      billToName: billTo?.name ?? quote.billToName,
      billToAddress: billTo?.address ?? quote.billToAddress,
      billToTaxId: billTo?.taxId ?? quote.billToTaxId,
    };

    // Real image loader: pull bytes from quote_images, constrained to BOTH the
    // image id AND this quote. RLS already blocks cross-tenant rows; matching
    // quote_id additionally closes the same-org cross-quote case (an image that
    // belongs to a different quote in the same org can't be embedded here).
    const loadImage = async (imageId: string): Promise<{ data: Buffer } | null> => {
      const [img] = await db
        .select({ data: quoteImages.imageData })
        .from(quoteImages)
        .where(and(eq(quoteImages.id, imageId), eq(quoteImages.quoteId, id)))
        .limit(1);
      return img?.data ? { data: img.data } : null;
    };

    // Product-image loader for catalog-sourced lines. RLS (partner-axis on
    // catalog_item_images) scopes reads to this partner's items; a failed/absent
    // image degrades to "no thumbnail" inside the renderer.
    const loadCatalogImage = async (catalogItemId: string): Promise<{ data: Buffer } | null> => {
      const img = await readCatalogItemImage(catalogItemId);
      return img?.data ? { data: img.data } : null;
    };

    // Pre-fetch the same render data Task 13's client editor/preview path uses
    // (system-context read of pinned template versions) and shape it for the
    // renderer: substituted HTML per authored contract block, plus any uploaded
    // contract PDFs to append after rendering (pdfkit can't draw an existing
    // PDF's pages — see pdfMerge.ts).
    const { contractRenderData, uploads } = await loadContractPdfInputs(blocks, quote);

    const { renderQuotePdf } = await import('../../services/quotePdf');
    const pdf = await renderQuotePdf(quoteForRender, blocks, lines, loadImage, branding, loadCatalogImage, contractRenderData);
    const { mergeUploadedContractPdfs } = await import('../../services/pdfMerge');
    const finalPdf = await mergeUploadedContractPdfs(pdf, uploads);

    const filename = safeContentDispositionFilename(`quote-${quote.quoteNumber || quote.id}.pdf`);
    return new Response(new Uint8Array(finalPdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': String(finalPdf.length),
      },
    });
  } catch (err) { return handleServiceError(c, err); }
});
