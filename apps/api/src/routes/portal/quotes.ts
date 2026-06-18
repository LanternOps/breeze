import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../db';
import { quotes, quoteBlocks, quoteLines } from '../../db/schema/quotes';
import { partners } from '../../db/schema/orgs';
import { portalBranding } from '../../db/schema/portal';
import { acceptQuoteSchema, declineQuoteSchema } from '@breeze/shared';
import { markQuoteViewed } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { readQuoteImage } from '../../services/quoteImageStorage';
import { QuoteServiceError } from '../../services/quoteTypes';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const quoteRoutes = new Hono();
const idParam = z.object({ id: z.string().guid() });
const imageParam = z.object({ id: z.string().guid(), imageId: z.string().guid() });

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
  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
  const lines = (await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible);
  try { await markQuoteViewed(id, auth.user.orgId); } catch (err) { console.error('[portal] quote markViewed failed', { id, err }); }
  return c.json({ data: { quote, blocks, lines } });
});

// GET /quotes/:id/pdf
quoteRoutes.get('/quotes/:id/pdf', zValidator('param', idParam), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId))).limit(1);
  if (!quote || quote.status === 'draft') return c.json({ error: 'Quote not found' }, 404);
  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder);
  const [partner] = await db.select({ name: partners.name, footer: partners.invoiceFooter, currency: partners.currencyCode }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
  const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor, footerText: portalBranding.footerText }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
  const loadImage = async (imageId: string) => { const img = await readQuoteImage(imageId, id); return img ? { data: img.data } : null; };
  const { renderQuotePdf } = await import('../../services/quotePdf');
  const pdf = await renderQuotePdf(quote, blocks, lines, loadImage, {
    partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null,
    footer: quote.terms ?? partner?.footer ?? brand?.footerText ?? null, currencyCode: quote.currencyCode ?? partner?.currency ?? 'USD',
  });
  const filename = safeContentDispositionFilename(`quote-${quote.quoteNumber || quote.id}.pdf`);
  return new Response(new Uint8Array(pdf), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Content-Length': String(pdf.length) } });
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

// POST /quotes/:id/accept — signer identity = the authenticated portal user.
quoteRoutes.post('/quotes/:id/accept', zValidator('param', idParam), zValidator('json', acceptQuoteSchema.partial()), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param');
  const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  try {
    const res = await acceptQuote({
      quoteId: id, signerName: auth.user.name || auth.user.email, signerEmail: auth.user.email,
      ipAddress: getTrustedClientIpOrUndefined(c) ?? null, userAgent: c.req.header('user-agent') ?? null, actorUserId: null,
    });
    return c.json({ data: { invoiceId: res.invoiceId, status: res.quote.status } });
  } catch (err) { if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status); throw err; }
});

// POST /quotes/:id/decline
quoteRoutes.post('/quotes/:id/decline', zValidator('param', idParam), zValidator('json', declineQuoteSchema), async (c) => {
  const auth = c.get('portalAuth'); const { id } = c.req.valid('param'); const { reason } = c.req.valid('json');
  const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, auth.user.orgId), ne(quotes.status, 'draft'))).limit(1);
  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  if (quote.status !== 'sent' && quote.status !== 'viewed') return c.json({ error: `Cannot decline a quote in status ${quote.status}`, code: 'INVALID_STATE' }, 409);
  const now = new Date();
  await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, id));
  return c.json({ data: { status: 'declined' } });
});
