import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createQuoteSchema, updateQuoteSchema, quoteLineInputSchema, catalogQuoteLineSchema,
  updateQuoteLineSchema, quoteBlockInputSchema, listQuotesQuerySchema,
} from '@breeze/shared';
import {
  createQuote, getQuote, listQuotes, updateQuote, deleteDraftQuote,
  addManualLine, addCatalogLine, updateLine, removeLine, addBlock, deleteBlock,
} from '../../services/quoteService';
import { QuoteServiceError, type QuoteActor } from '../../services/quoteTypes';
import { db } from '../../db';
import { quoteImages } from '../../db/schema/quotes';
import { partners } from '../../db/schema/orgs';
import { portalBranding } from '../../db/schema/portal';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';

export const quoteCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });
const blockParam = z.object({ id: z.string().guid(), blockId: z.string().guid() });

export function quoteActorFrom(c: { get: (k: string) => unknown }): QuoteActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
export function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status);
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
quoteCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await getQuote(c.req.valid('param').id, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
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
quoteCrudRoutes.delete('/:id/blocks/:blockId', scopes, writePerm, zValidator('param', blockParam), async (c) => {
  try { const p = c.req.valid('param'); await deleteBlock(p.id, p.blockId, quoteActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', quoteLineInputSchema), async (c) => {
  try { return c.json({ data: await addManualLine(c.req.valid('param').id, c.req.valid('json'), quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.post('/:id/lines/catalog', scopes, writePerm, zValidator('param', idParam), zValidator('json', catalogQuoteLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addCatalogLine(c.req.valid('param').id, b.catalogItemId, b.quantity, b.blockId, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
quoteCrudRoutes.patch('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), zValidator('json', updateQuoteLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await updateLine(p.id, p.lineId, c.req.valid('json'), quoteActorFrom(c)) }); }
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
    const { quote, blocks, lines } = await getQuote(id, quoteActorFrom(c));

    const [partner] = await db
      .select({ name: partners.name, footer: partners.invoiceFooter, currency: partners.currencyCode })
      .from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
    const [brand] = await db
      .select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText })
      .from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);

    const branding = {
      partnerName: partner?.name ?? 'Proposal',
      logoUrl: brand?.logoUrl ?? null,
      primaryColor: brand?.primaryColor ?? null,
      footer: quote.terms ?? partner?.footer ?? brand?.footerText ?? null,
      currencyCode: quote.currencyCode ?? partner?.currency ?? 'USD',
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

    const { renderQuotePdf } = await import('../../services/quotePdf');
    const pdf = await renderQuotePdf(quote, blocks, lines, loadImage, branding);

    const filename = safeContentDispositionFilename(`quote-${quote.quoteNumber || quote.id}.pdf`);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': String(pdf.length),
      },
    });
  } catch (err) { return handleServiceError(c, err); }
});
