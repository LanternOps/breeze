import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { acceptQuoteSchema, declineQuoteSchema } from '@breeze/shared';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked, revokeQuoteAcceptJti } from '../services/quoteAcceptToken';
import { markQuoteViewed } from '../services/quoteLifecycle';
import { acceptQuote, emitAcceptInvoiceIssued } from '../services/quoteAcceptService';
import { readQuoteImage, loadCustomerLineImage } from '../services/quoteImageStorage';
import { QuoteServiceError } from '../services/quoteTypes';
import { toCustomerLines, attachCustomerLineImages, sanitizeQuoteBlocksForRead } from '../services/quoteService';
import { loadContractBlockRenderData, renderContractBlocksForClient } from '../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../services/contractTemplateService';
import { InvoiceServiceError } from '../services/invoiceTypes';
import { isQuoteExpired } from '../services/quoteExpiry';
import { createQuotePayLink } from '../services/quotePay';
import { computeQuoteTotals, toQuoteDepositConfig, type QuoteLineForMath } from '../services/quoteMath';
import { captureException } from '../services/sentry';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { toPublicQuoteHeader } from '../services/publicQuoteDto';

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
const tokenLineImageParam = z.object({ token: z.string().min(10), lineId: z.string().guid() });
const tokenBlockParam = z.object({ token: z.string().min(10), blockId: z.string().guid() });

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
  const { token } = c.req.valid('param');
  const claims = await resolve(c);
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  try {
    const data = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
      if (!quote || quote.status === 'draft') return null;
      const rawBlocks = sanitizeQuoteBlocksForRead(await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quote.id)).orderBy(quoteBlocks.sortOrder));
      const lines = toCustomerLines((await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(quoteLines.sortOrder)).filter((l) => l.customerVisible));
      const [partner] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
      const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor }).from(portalBranding).where(eq(portalBranding.orgId, quote.orgId)).limit(1);
      // Cosmetic view-stamping only — must never fail the render. Mirrors the
      // authenticated counterpart at portal/quotes.ts:48.
      try { await markQuoteViewed(quote.id, quote.orgId); } catch (err) { console.error('[quotesPublic] quote markViewed failed', { id: quote.id, err }); }
      // Derive the amount accept actually invoices (one-time only) so the prospect
      // sees an accurate "due on acceptance" instead of the recurring-inclusive total,
      // plus the deposit due + per-category subtotals for the summary panel.
      const totals = computeQuoteTotals(lines as QuoteLineForMath[], quote.taxRate ? parseFloat(quote.taxRate) : null, toQuoteDepositConfig(quote.depositType, quote.depositPercent));
      // Resolves every `contract` block's pinned template version (system context)
      // and replaces its raw authoring content with the token-gated render contract.
      const blocks = await renderContractBlocksForClient(rawBlocks, quote, (blockId) => `/quotes/public/${encodeURIComponent(token)}/contract-file/${blockId}`);
      const serializedLines = attachCustomerLineImages(lines, (lineId) => `/quotes/public/${encodeURIComponent(token)}/line-image/${lineId}`);
      return { quote: toPublicQuoteHeader(quote, totals), blocks, lines: serializedLines, branding: { partnerName: partner?.name ?? 'Proposal', logoUrl: brand?.logoUrl ?? null, primaryColor: brand?.primaryColor ?? null } };
    }));
    if (!data) return c.json({ error: 'Quote not found' }, 404);
    return c.json({ data });
  } catch (err) {
    if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
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

// GET /:token/line-image/:lineId — per-line product thumbnail (uploaded image or
// the line's snapshotted catalog item image), the customer counterpart to the
// authed /catalog/:id/image route. Same token-gated, system-scope read as the
// image route: quote_id resolved from the signature-verified token, the line
// lookup scoped to that quote (id AND quoteId, customer-visible) so a token
// holder can only reach images for lines on their own proposal.
quotesPublicRoutes.get('/:token/line-image/:lineId', zValidator('param', tokenLineImageParam), async (c) => {
  const claims = await resolve(c); const { lineId } = c.req.valid('param');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const img = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote) return null;
    return loadCustomerLineImage(quote.id, lineId);
  }));
  if (!img) return c.json({ error: 'Image not found' }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// GET /:token/contract-file/:blockId — uploaded contract PDF bytes, mirroring
// the /:token/images/:imageId asset route. Same token-gated, system-scope read as
// the image route: no auth header, quote_id resolved from the signature-verified
// token, eq(quoteBlocks.quoteId, quote.id) closes the cross-quote blockId case.
quotesPublicRoutes.get('/:token/contract-file/:blockId', zValidator('param', tokenBlockParam), async (c) => {
  const claims = await resolve(c); const { blockId } = c.req.valid('param');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const block = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote) return null;
    const [b] = await db.select().from(quoteBlocks).where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quote.id), eq(quoteBlocks.blockType, 'contract'))).limit(1);
    return b ?? null;
  }));
  if (!block) return c.json({ error: 'Contract file not found' }, 404);
  const [renderData] = await loadContractBlockRenderData([block], { includeFileData: true });
  if (!renderData || renderData.sourceType !== 'uploaded' || !renderData.fileData) return c.json({ error: 'Contract file not found' }, 404);
  return new Response(new Uint8Array(renderData.fileData), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(renderData.fileData.length), 'Cache-Control': 'private, max-age=300' } });
});

// POST /:token/accept — typed signature. System-scope write, token-resolved.
quotesPublicRoutes.post('/:token/accept', zValidator('param', tokenParam), zValidator('json', acceptQuoteSchema), async (c) => {
  const claims = await resolve(c); const body = c.req.valid('json');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  try {
    // Pre-fetch the contract-block render data BEFORE the accept transaction —
    // symmetry with the portal path. loadContractBlockRenderData resolves the
    // pinned template versions under a system context; acceptQuote's guard
    // hard-fails if any contract block on the quote is missing from this set.
    const blocks = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType, content: quoteBlocks.content })
        .from(quoteBlocks).where(eq(quoteBlocks.quoteId, claims.quoteId)).orderBy(quoteBlocks.sortOrder)));
    const contractRenderData = await loadContractBlockRenderData(blocks, { includeFileData: true });
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptQuote({
      quoteId: claims.quoteId, signerName: body.signerName, signerEmail: body.signerEmail ?? null,
      ipAddress: getTrustedClientIpOrUndefined(c) ?? null, userAgent: c.req.header('user-agent') ?? null,
      acceptanceTokenJti: claims.jti, actorUserId: null,
      contractRenderData,
    })));
    // Post-commit (atom-2): consume the single-use token so the link can't be replayed.
    // A failed revoke leaves the accept link replayable (security-relevant) → capture.
    try { await revokeQuoteAcceptJti(claims.jti); } catch (err) { console.error('[quotesPublic] jti revoke failed', err); captureException(err instanceof Error ? err : new Error(String(err))); }
    // Post-commit: emit invoice.issued + enqueue the PDF render (matches issueInvoice).
    // Fire-and-forget; a public accepter has no user id.
    await emitAcceptInvoiceIssued(res, null);
    // Phase 3 accept→pay: mint a Stripe checkout link for the just-issued invoice and
    // return it (the accept token is now revoked, so the URL must come back in THIS
    // response). Runs in its own context AFTER the accept committed — it must never
    // fail (or roll back) the accept. Distinguish EXPECTED no-pay outcomes (a $0 quote
    // → NOTHING_TO_PAY/NOT_PAYABLE, or the partner hasn't connected Stripe) — surfaced
    // quietly as payUrl:null — from an UNEXPECTED failure (Stripe outage, DB), which we
    // flag as payDeferred + capture so a silently-lost payment CTA is observable rather
    // than looking identical to "nothing to pay".
    let payUrl: string | null = null;
    let payDeferred = false;
    try {
      const link = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        createQuotePayLink(claims.quoteId, { userId: null, partnerId: null, accessibleOrgIds: [claims.orgId] })));
      payUrl = link.url;
    } catch (err) {
      const benign = err instanceof InvoiceServiceError
        && (err.code === 'NOT_PAYABLE' || err.code === 'NOTHING_TO_PAY' || err.code === 'STRIPE_NOT_CONNECTED');
      if (!benign) {
        payDeferred = true;
        console.error('[quotesPublic] pay-link mint failed after accept', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return c.json({ data: { status: res.quote.status, invoiceNumber: null, payUrl, payDeferred, pax8OrderId: res.pax8OrderId } });
  } catch (err) {
    if (err instanceof QuoteServiceError) {
      if (err.code === 'RESPONSE_CONSUMED') {
        // Durable backstop fired (Redis marker lost): re-arm it so repeat
        // replays die at the cheap resolve() gate; failure here is benign.
        try { await revokeQuoteAcceptJti(claims.jti); } catch { /* durable backstop holds */ }
      }
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    // loadContractBlockRenderData throws this for a missing/mismatched pinned version.
    if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// POST /:token/decline
quotesPublicRoutes.post('/:token/decline', zValidator('param', tokenParam), zValidator('json', declineQuoteSchema), async (c) => {
  const claims = await resolve(c); const { reason } = c.req.valid('json');
  if (!claims) return c.json({ error: 'This link is invalid or has expired' }, 401);
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), eq(quotes.orgId, claims.orgId))).limit(1);
    if (!quote) return 'bad_state' as const;
    // Durable single-use backstop (#2875, wave-3 schema 2026-08-06-c): this jti
    // was already consumed on the row → replay, even when the Redis revocation
    // marker was lost (flush/failover/TTL). Checked BEFORE the status guard so
    // a replayed link 401s exactly like the Redis resolve() gate does.
    if (quote.publicResponseConsumedAt != null && quote.publicResponseJti === claims.jti) return 'consumed' as const;
    // Forward-compat guard for the wave-3 v1 model (jti persisted at send with
    // public_token_version=1): a version-1 row may only be consumed by the jti
    // it was issued with. Inert for today's version-0 rows.
    if ((quote.publicTokenVersion ?? 0) !== 0 && quote.publicResponseJti !== claims.jti) return 'consumed' as const;
    if (quote.status !== 'sent' && quote.status !== 'viewed') return 'bad_state' as const;
    // Read-time expiry guard (Phase 3): an expired quote is terminal — mirror the
    // acceptQuote / declineQuoteByActor 410 so the sub-sweep window is covered here too.
    if (isQuoteExpired(quote.expiryDate)) return 'expired' as const;
    const now = new Date();
    // Consume the durable response capability in the SAME statement as the
    // decline (#2875): jti + consumed_at + outcome land atomically with the
    // status change; the Redis revoke below stays the hot-path check. The
    // status filter re-asserts the guard at write time so a concurrent accept
    // (which holds a FOR UPDATE lock and flips status to 'converted') can't be
    // overwritten by this unlocked read-then-write — 0 rows matched → 409.
    const updated = await db.update(quotes).set({
      status: 'declined', declineReason: reason ?? null, declinedAt: now, updatedAt: now,
      publicResponseJti: claims.jti, publicResponseConsumedAt: now, publicResponseOutcome: 'declined',
    }).where(and(
      eq(quotes.id, quote.id),
      inArray(quotes.status, ['sent', 'viewed']),
      // Re-assert non-consumption at write time too (belt to the status
      // strap): a concurrent consumer that somehow left status untouched
      // still can't be overwritten.
      isNull(quotes.publicResponseConsumedAt),
    )).returning({ id: quotes.id });
    if (updated.length === 0) return 'bad_state' as const;
    return 'ok' as const;
  }));
  if (result === 'expired') return c.json({ error: 'This quote has expired', code: 'QUOTE_EXPIRED' }, 410);
  if (result === 'consumed') {
    // Re-arm the lost Redis marker so repeat replays die at the cheap
    // resolve() gate instead of re-reading the row each time; the durable
    // backstop holds regardless, so a failed re-arm is benign.
    try { await revokeQuoteAcceptJti(claims.jti); } catch { /* durable backstop holds */ }
    return c.json({ error: 'This link is invalid or has expired', code: 'RESPONSE_CONSUMED' }, 401);
  }
  if (result !== 'ok') return c.json({ error: 'This quote can no longer be declined' }, 409);
  // Consume the single-use token post-commit so a declined link can't be replayed.
  // A failed revoke leaves the link replayable (security-relevant) → capture.
  try { await revokeQuoteAcceptJti(claims.jti); } catch (err) { console.error('[quotesPublic] jti revoke failed', err); captureException(err instanceof Error ? err : new Error(String(err))); }
  return c.json({ data: { status: 'declined' } });
});
