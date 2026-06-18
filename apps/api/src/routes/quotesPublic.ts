import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { acceptQuoteSchema, declineQuoteSchema } from '@breeze/shared';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked, revokeQuoteAcceptJti } from '../services/quoteAcceptToken';
import { markQuoteViewed } from '../services/quoteLifecycle';
import { acceptQuote } from '../services/quoteAcceptService';
import { readQuoteImage } from '../services/quoteImageStorage';
import { QuoteServiceError } from '../services/quoteTypes';
import { isQuoteExpired } from '../services/quoteExpiry';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';

/**
 * Unauthenticated, token-gated quote acceptance surface for prospects without a
 * portal account. SECURITY: this router has NO auth middleware, so every DB op
 * runs through runOutsideDbContext(() => withSystemDbAccessContext(...)) scoped
 * to the org_id/quote_id resolved from a *signature-verified* token (a bare `db`
 * write here would silently match 0 rows under breeze_app RLS — the
 * rls_silent_zero_row_write class). The token is the only authorization: it is
 * minted on send, revocable by jti, and carries the orgId/quoteId/partnerId.
 * Mounted at /quotes/public BEFORE the auth-gated /quotes router in index.ts.
 */
export const quotesPublicRoutes = new Hono();
const tokenParam = z.object({ token: z.string().min(10) });
const tokenImageParam = z.object({ token: z.string().min(10), imageId: z.string().guid() });

// Resolve + verify the token, returning the scoped claims or null.
async function resolve(c: { req: { valid: (k: 'param') => { token: string } } }) {
  const { token } = c.req.valid('param');
  const claims = await verifyQuoteAcceptToken(token);
  if (!claims) return null;
  if (await isQuoteAcceptJtiRevoked(claims.jti)) return null;
  return claims;
}

// GET /:token — view. Stamps first_viewed_at + sent→viewed. Customer-visible content only.
quotesPublicRoutes.get('/:token', zValidator('param', tokenParam), async (c) => {
  const claims = await resolve(c);
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const data = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote || quote.status === 'draft') return null;
    const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quote.id)).orderBy(quoteBlocks.sortOrder);
    const lines = (await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible);
    const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
    const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
    await markQuoteViewed(quote.id, quote.orgId);
    return { quote: { ...quote, status: quote.status === 'sent' ? 'viewed' : quote.status }, blocks, lines, branding: { partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null } };
  }));
  if (!data) return c.json({ error: 'Quote not found' }, 404);
  return c.json({ data });
});

// GET /:token/images/:imageId
quotesPublicRoutes.get('/:token/images/:imageId', zValidator('param', tokenImageParam), async (c) => {
  const claims = await resolve(c); const { imageId } = c.req.valid('param');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const img = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote) return null;
    return readQuoteImage(imageId, quote.id);
  }));
  if (!img) return c.json({ error: 'Image not found' }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// POST /:token/accept — typed signature. System-scope write, token-resolved.
quotesPublicRoutes.post('/:token/accept', zValidator('param', tokenParam), zValidator('json', acceptQuoteSchema), async (c) => {
  const claims = await resolve(c); const body = c.req.valid('json');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  try {
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptQuote({
      quoteId: claims.quoteId, signerName: body.signerName, signerEmail: body.signerEmail ?? null,
      ipAddress: getTrustedClientIpOrUndefined(c) ?? null, userAgent: c.req.header('user-agent') ?? null,
      acceptanceTokenJti: claims.jti, actorUserId: null,
    })));
    // Post-commit (atom-2): consume the single-use token so the link can't be replayed.
    try { await revokeQuoteAcceptJti(claims.jti); } catch (err) { console.error('[quotesPublic] jti revoke failed', err); }
    return c.json({ data: { status: res.quote.status, invoiceNumber: null } });
  } catch (err) { if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status); throw err; }
});

// POST /:token/decline
quotesPublicRoutes.post('/:token/decline', zValidator('param', tokenParam), zValidator('json', declineQuoteSchema), async (c) => {
  const claims = await resolve(c); const { reason } = c.req.valid('json');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote || (quote.status !== 'sent' && quote.status !== 'viewed')) return 'bad_state' as const;
    // Read-time expiry guard (Phase 3): an expired quote is terminal — mirror the
    // acceptQuote / declineQuoteByActor 410 so the sub-sweep window is covered here too.
    if (isQuoteExpired(quote.expiryDate)) return 'expired' as const;
    const now = new Date();
    await db.update(quotes).set({ status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now }).where(eq(quotes.id, quote.id));
    return 'ok' as const;
  }));
  if (result === 'expired') return c.json({ error: 'This quote has expired', code: 'QUOTE_EXPIRED' }, 410);
  if (result !== 'ok') return c.json({ error: 'This quote can no longer be declined' }, 409);
  // Consume the single-use token post-commit so a declined link can't be replayed.
  try { await revokeQuoteAcceptJti(claims.jti); } catch (err) { console.error('[quotesPublic] jti revoke failed', err); }
  return c.json({ data: { status: 'declined' } });
});
