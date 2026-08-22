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
  createQuoteOrderSchema, updateQuoteOrderSchema, updateQuoteOrderLineSchema,
  changeCurrencySchema, buildStripeCurrencyWarning,
} from '@breeze/shared';
import {
  createQuote, cloneQuote, reviseQuote, getQuote, listQuotes, updateQuote, deleteDraftQuote,
  addManualLine, addCatalogLine, updateLine, removeLine, addBlock, updateBlock, deleteBlock,
  reorderBlocks, reorderLines, moveLineToBlock, changeQuoteCurrency,
} from '../../services/quoteService';
import { createQuoteOrder, updateQuoteOrder, updateQuoteOrderLine } from '../../services/quoteOrderService';
import { QuoteServiceError, type QuoteActor } from '../../services/quoteTypes';
import { db } from '../../db';
import { quoteImages } from '../../db/schema/quotes';
import { readCatalogItemImage } from '../../services/catalogImageStorage';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { resolveQuoteBranding } from '../../services/quoteBranding';
import { getQuoteRecipients } from '../../services/quoteLifecycle';
import { getConnection } from '../../services/stripeConnectService';
import {
  renderContractBlocksForClient,
  loadContractPdfInputs,
  loadContractBlockAuthoring,
  attachContractAuthoring,
} from '../../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';
import { PdfMergeError } from '../../services/pdfMerge';
import { writeRouteAudit } from '../../services/auditEvents';

export const quoteCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const fulfillPerm = requirePermission(PERMISSIONS.QUOTES_FULFILL.resource, PERMISSIONS.QUOTES_FULFILL.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });
const blockParam = z.object({ id: z.string().guid(), blockId: z.string().guid() });
const orderParam = z.object({ id: z.string().guid(), orderId: z.string().guid() });
const orderLineParam = z.object({ id: z.string().guid(), orderId: z.string().guid(), lineId: z.string().guid() });

export function quoteActorFrom(c: { get: (k: string) => unknown }): QuoteActor {
  const auth = c.get('auth') as AuthContext;
  // These routes require partner/system scope, where allowedSiteIds is undefined
  // (unrestricted) — threading it is a no-op today but keeps the actor honest if an
  // org/site-scoped token is ever admitted here.
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds, allowedSiteIds: auth.allowedSiteIds };
}
export function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof QuoteServiceError) {
    return c.json(err.meta ? { error: err.message, code: err.code, meta: err.meta } : { error: err.message, code: err.code }, err.status);
  }
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
// POST /:id/revise — create a linked draft revision of an issued quote. The
// parent stays live; superseding it on send belongs to a later wave documented
// in docs/superpowers/plans/2026-08-17-quote-revisions.md.
// quotes:write like clone; the send itself will require quotes:send.
quoteCrudRoutes.post('/:id/revise', scopes, writePerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const actor = quoteActorFrom(c);
    const { quote: parent } = await getQuote(id, actor);
    const revision = await reviseQuote(id, actor);
    writeRouteAudit(c, {
      orgId: revision.orgId,
      action: 'quote.revised',
      resourceType: 'quote',
      resourceId: revision.id,
      result: 'success',
      details: { parentQuoteId: id, revisionNumber: revision.revisionNumber, parentStatus: parent.status },
    });
    return c.json({ data: revision });
  } catch (err) { return handleServiceError(c, err); }
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
    // `branding.locale` so an unstamped draft's contract totals render in the
    // same locale as the quote totals on the same page (#3777).
    const blocks = await renderContractBlocksForClient(detail.blocks, detail.quote, (blockId) => `/quotes/${id}/contract-file/${blockId}`, branding.locale);
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
    // Who this quote actually went to. Written at send but, until now, only ever
    // read by the portal's signer-authorization check — so the tech who sent it
    // had no way to see the addresses. Empty on drafts and on legacy sends that
    // predate quote_recipients.
    const recipients = await getQuoteRecipients(id);
    // Multi-currency (#3777, spec §10 / review F5): Stripe connection status +
    // the warn-don't-block currency warning are precomputed HERE, from the
    // partner's cached connection row (same shape as getInvoice). `quotes:send`
    // is grantable without `billing:manage`, so the send composer must never
    // learn this from the BILLING_MANAGE-only /partner/stripe-connect endpoint —
    // a sender without billing admin got a silent 403 and no FX-spread warning.
    // Cached columns only, no Stripe call. A lookup FAILURE is reported as
    // `null` (unknown) rather than `false`: "disconnected" would show the
    // deposit-can't-be-paid warning on a connected account.
    let conn: Awaited<ReturnType<typeof getConnection>> | undefined;
    try { conn = await getConnection(detail.quote.partnerId); } catch { conn = undefined; }
    const stripeConnected: boolean | null = conn === undefined ? null : conn?.status === 'connected';
    const stripeAccountCurrency = stripeConnected ? conn?.defaultCurrency ?? null : null;
    const currencyWarning = stripeConnected ? buildStripeCurrencyWarning(detail.quote.currencyCode, conn?.defaultCurrency) : null;
    // Strip the accept-token identity before it leaves the API. getQuote reads
    // the whole `quotes` row, but these four columns are classified
    // excludedSensitive in CORE_TENANT_EXPORT_POLICY (they are the material
    // that reproduces a live accept credential) — shipping them to every
    // quotes:read holder would hand exactly the users we deliberately deny the
    // share-link endpoint everything except the signing key.
    const {
      acceptTokenJti: _jti, acceptTokenIssuedAt: _iat,
      acceptTokenExpiresAt: _exp, acceptTokenKid: _kid,
      ...quoteForClient
    } = detail.quote;
    // Sibling of `branding` — same resolved values (no extra query), typed
    // explicitly so web doesn't have to depend on QuoteBranding growing new
    // fields to pick up theme/pageSize (Task 12).
    const presentation = { theme: branding.theme, pageSize: branding.pageSize };
    return c.json({ data: {
      ...detail, quote: quoteForClient, blocks: blocksForEditor, branding, presentation, recipients,
      stripeConnected, stripeAccountCurrency, currencyWarning,
    } });
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
// Draft-only atomic change-currency op (#3774) — the ONLY mutation path for a
// document's stamped currency. CURRENCY_LOCKED (409) when monetary lines exist
// and clearLines wasn't passed; clearLines deletes lines + restamps atomically.
quoteCrudRoutes.post('/:id/currency', scopes, writePerm, zValidator('param', idParam), zValidator('json', changeCurrencySchema), async (c) => {
  try { return c.json({ data: await changeQuoteCurrency(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
// Block writes answer `{ data, warnings }`. `warnings` is always present (often
// empty) and names any markup the rich-text sanitizer had to discard, so an
// author is never told "saved" about content that silently went away (#3520).
quoteCrudRoutes.post('/:id/blocks', scopes, writePerm, zValidator('param', idParam), zValidator('json', quoteBlockInputSchema), async (c) => {
  try {
    const { warnings, ...data } = await addBlock(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c));
    return c.json({ data, warnings });
  }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/blocks/reorder', scopes, writePerm, zValidator('param', idParam), zValidator('json', reorderBlocksSchema), async (c) => {
  try { const { id } = c.req.valid('param'); await reorderBlocks(id, c.req.valid('json').blockIds, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/blocks/:blockId', scopes, writePerm, zValidator('param', blockParam), zValidator('json', quoteBlockInputSchema), async (c) => {
  try {
    const p = c.req.valid('param');
    const { warnings, ...data } = await updateBlock(p.id, p.blockId, c.req.valid('json'), quoteActorFrom(c));
    return c.json({ data, warnings });
  }
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

// Fulfillment (procurement order tracking) — gated on quotes:fulfill, a
// separate permission from quotes:write so a tech that can edit a draft can't
// necessarily record real-world purchase orders against it (and vice versa).
quoteCrudRoutes.post('/:id/orders', scopes, fulfillPerm, zValidator('param', idParam), zValidator('json', createQuoteOrderSchema), async (c) => {
  try {
    const { created, ...order } = await createQuoteOrder(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c));
    // Only audit an actual creation — a deduped retry (same clientRequestId)
    // did no write this call, so logging quote_order_created again would be
    // noise attributing a second "creation" to a request that changed nothing.
    if (created) {
      writeRouteAudit(c, {
        orgId: order.orgId, action: 'quote_order_created', resourceType: 'quote',
        resourceId: order.quoteId, details: { orderId: order.id, lineCount: order.lines.length },
      });
    }
    return c.json({ data: order });
  } catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/orders/:orderId', scopes, fulfillPerm, zValidator('param', orderParam), zValidator('json', updateQuoteOrderSchema), async (c) => {
  try {
    const p = c.req.valid('param');
    const order = await updateQuoteOrder(p.id, p.orderId, c.req.valid('json'), quoteActorFrom(c));
    writeRouteAudit(c, {
      orgId: order.orgId, action: 'quote_order_updated', resourceType: 'quote',
      resourceId: order.quoteId, details: { orderId: order.id },
    });
    return c.json({ data: order });
  } catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/orders/:orderId/lines/:lineId', scopes, fulfillPerm, zValidator('param', orderLineParam), zValidator('json', updateQuoteOrderLineSchema), async (c) => {
  try {
    const p = c.req.valid('param');
    const body = c.req.valid('json');
    const { changed, ...line } = await updateQuoteOrderLine(p.id, p.orderId, p.lineId, body, quoteActorFrom(c));
    // Skip the audit on the no-op early-return path (an empty/all-undefined
    // patch) — nothing changed, so there's nothing to attribute.
    if (changed) {
      writeRouteAudit(c, {
        orgId: line.orgId, action: 'quote_order_line_updated', resourceType: 'quote',
        resourceId: line.quoteId,
        details: {
          orderId: line.orderId, lineId: line.id,
          ...(body.cancelled !== undefined ? { cancelled: body.cancelled } : {}),
          ...(body.receivedQty !== undefined ? { receivedQty: body.receivedQty } : {}),
        },
      });
    }
    return c.json({ data: line });
  } catch (err) { return handleServiceError(c, err); }
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
    // Must receive quoteForRender (the billTo-overlaid row), not the raw quote:
    // on a DRAFT the raw row's billToName is still null, so {{client.name}} (and
    // client.address) blank-fill in the contract text while the page header —
    // rendered from quoteForRender three lines down — shows the org name fine.
    const { contractRenderData, uploads } = await loadContractPdfInputs(blocks, quoteForRender, branding.locale);

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
