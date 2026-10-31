import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteBlocks } from '../db/schema/quotes';
import { partners } from '../db/schema/orgs';
import { acceptQuoteSchema, declineQuoteSchema, ERROR_CODES } from '@breeze/shared';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked, revokeQuoteAcceptJti, type QuoteAcceptClaims } from '../services/quoteAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMerge';
import { markQuoteViewed } from '../services/quoteLifecycle';
import { acceptQuote, emitAcceptInvoiceIssued, resolveAcceptInvoiceUrl, autoEmailAcceptedInvoice } from '../services/quoteAcceptService';
import { notifyQuoteOutcome } from '../services/quoteOutcomeNotify';
import { readQuoteImage, loadCustomerLineImage } from '../services/quoteImageStorage';
import { QuoteServiceError } from '../services/quoteTypes';
import { loadContractBlockRenderData } from '../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../services/contractTemplateService';
import { isQuoteExpired } from '../services/quoteExpiry';
import { captureException } from '../services/sentry';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { toPublicQuotePresentation } from '../services/publicQuoteDto';
import { resolveQuoteLinkOrgGate, PUBLIC_LINK_ORG_UNAVAILABLE, type PublicLinkOrgGate } from '../services/publicLinkOrgGate';
import { isPayOnAcceptAvailable, resolveAcceptCheckoutUrl, publicInvoiceCheckoutUrls } from '../services/quoteAcceptCheckout';
import { assembleCustomerQuoteDocument } from '../services/customerQuoteDocument';
import { renderCustomerQuotePdf, customerQuotePdfFilename } from '../services/customerQuotePdf';
import { PdfMergeError } from '../services/pdfMerge';
import { getConvertedInvoicePayment, type ConvertedQuotePayment } from '../services/quotePay';
import { createInvoicePayLink } from '../services/invoiceCheckout';
import { InvoiceServiceError } from '../services/invoiceTypes';
import { CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE } from '../services/stripeCheckoutErrors';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';

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

// Resolve + verify the token, returning the scoped claims plus the set of
// orgIds the quote may legitimately live under (its own claimed orgId, plus
// any orgs it was merged into per org_merge_events — Task 6, org-lifecycle
// merge continuity) — or null. Computed once per request so every handler's
// DB match uses the same resolved set instead of re-walking the merge chain
// per query. resolveMergedOrgIds escalates to system scope internally, so
// this is safe to call from a route that has no ambient DB context yet.
// Also resolves the org-lifecycle gate (Wave 4): ONE system-context read of the
// status of the org that owns the quote TODAY — the merge SURVIVOR when the
// token's own org merged away, since `orgIds` is exactly the set the row lookup
// uses. Computed here so it is shared by every handler instead of re-read per
// query, and applied to reads as well as writes: an archived org is hidden, so
// its quote link must read as gone rather than serve a live proposal.
async function resolve(c: { req: { valid: (k: 'param') => { token: string } } }): Promise<{ claims: QuoteAcceptClaims; orgIds: string[]; gate: PublicLinkOrgGate } | null> {
  const { token } = c.req.valid('param');
  const claims = await verifyQuoteAcceptToken(token);
  if (!claims) return null;
  if (await isQuoteAcceptJtiRevoked(claims.jti)) return null;
  const orgIds = await resolveMergedOrgIds(claims.orgId, claims.partnerId);
  const gate = await resolveQuoteLinkOrgGate(claims.quoteId, orgIds);
  return { claims, orgIds, gate };
}

/** The columns every token route needs to judge whether the link is still live. */
const publicLinkColumns = {
  id: quotes.id,
  status: quotes.status,
  publicLinkRevokedAt: quotes.publicLinkRevokedAt,
};

/**
 * A replaced quote's public link is dead: the revision that superseded it revoked
 * it in the same statement that flipped its status. Both are checked because
 * publicLinkRevokedAt is the DB-authoritative revocation and must keep working for
 * any future standalone link-revoke that does not change status.
 *
 * ONE predicate, used by every token route, so adding a route cannot silently
 * reopen a revoked link. quotesPublic.superseded.test.ts enumerates the routes and
 * fails if a new one skips this.
 */
function isPublicLinkDead(q: { status: string; publicLinkRevokedAt: Date | null }): boolean {
  return q.status === 'superseded' || q.publicLinkRevokedAt != null;
}

/** Load the token's quote for an asset route, or null when the link is dead. */
// orgIds: the token org plus transitive merge survivors (resolveMergedOrgIds) —
// quoteId still hard-constrains the row; the widening only rescues merged-away orgs.
async function loadLiveAssetQuote(claims: { quoteId: string }, orgIds: string[]) {
  const [quote] = await db.select(publicLinkColumns).from(quotes)
    .where(and(eq(quotes.id, claims.quoteId), inArray(quotes.orgId, orgIds))).limit(1);
  if (!quote || isPublicLinkDead(quote)) return null;
  return quote;
}

// GET /:token — view. Stamps first_viewed_at + sent→viewed. Customer-visible content only.
quotesPublicRoutes.get('/:token', zValidator('param', tokenParam), async (c) => {
  const { token } = c.req.valid('param');
  const resolved = await resolve(c);
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
  try {
    const data = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), inArray(quotes.orgId, orgIds))).limit(1);
      if (!quote || quote.status === 'draft') return null;
      if (isPublicLinkDead(quote)) {
        const [p] = await db.select({ name: partners.name }).from(partners)
          .where(eq(partners.id, quote.partnerId)).limit(1);
        return { superseded: true as const, partnerName: p?.name ?? 'your provider' };
      }
      // The customer document (#9418): the one assembler every quote surface
      // uses. 'public' keeps the public link's status mapping (sent → viewed)
      // and refuses a retired status (410, mapped below); the token scopes the
      // asset paths. Branding carries the MSP's published support contact so the
      // page can tell a prospect how to reach the company asking them to sign.
      const enc = encodeURIComponent(token);
      const doc = await assembleCustomerQuoteDocument(quote, 'public', {
        assets: {
          lineImage: (l) => `/quotes/public/${enc}/line-image/${l.id}`,
          contractFile: (blockId) => `/quotes/public/${enc}/contract-file/${blockId}`,
        },
      });
      // Cosmetic view-stamping only — must never fail the render. Mirrors the
      // authenticated counterpart in portal/quotes.ts. After assembly, so a
      // proposal that failed to render is not recorded as viewed.
      try { await markQuoteViewed(quote.id, quote.orgId); } catch (err) { console.error('[quotesPublic] quote markViewed failed', { id: quote.id, err }); }
      const { theme, pageSize } = doc.branding;
      return { owner: { partnerId: quote.partnerId }, payload: {
        quote: doc.quote, blocks: doc.blocks, lines: doc.lines,
        branding: { ...doc.branding, partnerName: doc.branding.partnerName ?? 'Proposal' },
        presentation: toPublicQuotePresentation(theme, pageSize),
        documentLocale: doc.documentLocale,
      } };
    }));
    if (data && 'superseded' in data) {
      // Deliberately withhold the successor: the latest email is the customer's
      // authorization path, and exposing it here would reveal an unsent document.
      return c.json({
        error: 'This proposal has been replaced by an updated version — please use the link in the latest email.',
        code: 'QUOTE_SUPERSEDED',
        data: { branding: { partnerName: data.partnerName } },
      }, 410);
    }
    if (!data) return c.json({ error: 'Quote not found', code: ERROR_CODES.NOT_FOUND }, 404);
    // #8231: tells the page whether signing goes straight on to card checkout,
    // so the button can say "Sign & pay". Read AFTER the system context above
    // closed (it opens its own) and best-effort: a failed read only costs the
    // copy, never the proposal. The accept route re-checks it before minting.
    let payOnAccept = false;
    try {
      payOnAccept = await isPayOnAcceptAvailable(data.owner.partnerId);
    } catch (err) {
      console.error('[quotesPublic] pay-on-accept availability read failed', { quoteId: claims.quoteId, err });
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
    return c.json({ data: { ...data.payload, payOnAccept } });
  } catch (err) {
    if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    // Fail-closed floor for any retired status that reaches serialization.
    if (err instanceof QuoteServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// GET /:token/images/:imageId
quotesPublicRoutes.get('/:token/images/:imageId', zValidator('param', tokenImageParam), async (c) => {
  const resolved = await resolve(c); const { imageId } = c.req.valid('param');
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
  const img = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const quote = await loadLiveAssetQuote(claims, orgIds);
    if (!quote) return null;
    return readQuoteImage(imageId, quote.id);
  }));
  if (!img) return c.json({ error: 'Image not found', code: ERROR_CODES.NOT_FOUND }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// GET /:token/line-image/:lineId — per-line product thumbnail (uploaded image or
// the line's snapshotted catalog item image), the customer counterpart to the
// authed /catalog/:id/image route. Same token-gated, system-scope read as the
// image route: quote_id resolved from the signature-verified token, the line
// lookup scoped to that quote (id AND quoteId, customer-visible) so a token
// holder can only reach images for lines on their own proposal.
quotesPublicRoutes.get('/:token/line-image/:lineId', zValidator('param', tokenLineImageParam), async (c) => {
  const resolved = await resolve(c); const { lineId } = c.req.valid('param');
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
  const img = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const quote = await loadLiveAssetQuote(claims, orgIds);
    if (!quote) return null;
    return loadCustomerLineImage(quote.id, lineId);
  }));
  if (!img) return c.json({ error: 'Image not found', code: ERROR_CODES.NOT_FOUND }, 404);
  return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
});

// GET /:token/contract-file/:blockId — uploaded contract PDF bytes, mirroring
// the /:token/images/:imageId asset route. Same token-gated, system-scope read as
// the image route: no auth header, quote_id resolved from the signature-verified
// token, eq(quoteBlocks.quoteId, quote.id) closes the cross-quote blockId case.
quotesPublicRoutes.get('/:token/contract-file/:blockId', zValidator('param', tokenBlockParam), async (c) => {
  const resolved = await resolve(c); const { blockId } = c.req.valid('param');
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
  const block = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const quote = await loadLiveAssetQuote(claims, orgIds);
    if (!quote) return null;
    const [b] = await db.select().from(quoteBlocks).where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quote.id), eq(quoteBlocks.blockType, 'contract'))).limit(1);
    return b ?? null;
  }));
  if (!block) return c.json({ error: 'Contract file not found', code: ERROR_CODES.NOT_FOUND }, 404);
  const [renderData] = await loadContractBlockRenderData([block], { includeFileData: true });
  if (!renderData || renderData.sourceType !== 'uploaded' || !renderData.fileData) return c.json({ error: 'Contract file not found', code: ERROR_CODES.NOT_FOUND }, 404);
  // c.body, not a bare `new Response`: headers middleware sets via c.header() before next() (the path-selected CSP
  // with `frame-ancestors 'self'`, #10192) are held as prepared headers and only applied to a response built through
  // the context.
  const bytes = new Uint8Array(renderData.fileData);
  return c.body(bytes, 200, { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'private, max-age=300' });
});

/** Same no-store / no-referrer / noindex set as the public invoice routes: the
 *  URL is the capability, so it must never land in caches, referrer logs or
 *  crawlers. */
function applyPublicLinkHeaders(c: { header: (k: string, v: string) => void }): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

/** Per-quote cap on PDF renders from the public link (the render is the
 *  expensive part of this unauthenticated surface). Same shape and size as the
 *  public invoice PDF's cap. Fail-open on a Redis outage, as there: a download
 *  is read-only, so availability wins over a strict cap. */
async function overPublicPdfLimit(quoteId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return !(await rateLimiter(redis, `quote-public:pdf:${quoteId}`, 10, 60)).allowed;
  } catch {
    return false;
  }
}

// GET /:token/pdf — the proposal as a PDF download (#9860), the same document
// the logged-in portal's Download PDF renders. Same gates as GET /:token
// (signature + exp, revoked jti, org lifecycle, token org set, draft) and the
// shared isPublicLinkDead predicate: a superseded or link-revoked proposal is
// not served — 404, like the asset routes, since withdrawn prices must not
// leave as a file either. An expired proposal is served, as the page is.
quotesPublicRoutes.get('/:token/pdf', zValidator('param', tokenParam), async (c) => {
  applyPublicLinkHeaders(c);
  const resolved = await resolve(c);
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
  const quote = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [q] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), inArray(quotes.orgId, orgIds))).limit(1);
    if (!q || q.status === 'draft' || isPublicLinkDead(q)) return null;
    return q;
  }));
  if (!quote) return c.json({ error: 'Quote not found', code: ERROR_CODES.NOT_FOUND }, 404);
  if (await overPublicPdfLimit(quote.id)) return c.json({ error: 'Too many requests', code: ERROR_CODES.RATE_LIMITED }, 429);
  try {
    // System scope: this router has no auth middleware, so the renderer's quote
    // reads need a context or RLS returns zero rows. Its partner read opens its own.
    const pdf = await runOutsideDbContext(() => withSystemDbAccessContext(() => renderCustomerQuotePdf(quote)));
    const bytes = new Uint8Array(pdf);
    // c.body, not a bare Response, so the headers set above (and middleware's
    // prepared headers) are applied — see the contract-file route.
    return c.body(bytes, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${customerQuotePdfFilename(quote)}"`,
      'Content-Length': String(bytes.byteLength),
    });
  } catch (err) {
    // An unreadable uploaded contract keeps its typed 4xx status and code, as on the portal
    // route, but not its message: that carries the PDF parser's own text, which an
    // unauthenticated caller has no use for. It is a fault in stored bytes that a 4xx hides
    // from 5xx alerting, so it is logged and reported here.
    if (err instanceof PdfMergeError) {
      console.error('[quotesPublic] proposal PDF contract merge failed', { quoteId: quote.id, err });
      captureException(err);
      return c.json({ error: 'This proposal’s PDF is unavailable right now. Please contact the sender.', code: err.code }, err.status);
    }
    throw err;
  }
});

// POST /:token/accept — typed signature. System-scope write, token-resolved.
quotesPublicRoutes.post('/:token/accept', zValidator('param', tokenParam), zValidator('json', acceptQuoteSchema), async (c) => {
  const resolved = await resolve(c); const body = c.req.valid('json');
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
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
    // Retired the one-shot Stripe payUrl (2026-08-21 spec §8): the response now
    // carries the invoice's DURABLE public url — the confirmation page
    // location.replace()s onto it, and it offers payment (and keeps working
    // after the tab closes). payDeferred survives only for the mint-failure
    // edge on an ISSUED invoice (a $0 recurring-only quote issues nothing and
    // legitimately gets invoiceUrl:null without the flag).
    const invoiceUrl = await resolveAcceptInvoiceUrl(res);
    const payDeferred = res.invoiceIssued && invoiceUrl == null;
    // Auto-email the issued invoice (public link CTA) so closing the tab is
    // harmless, and tell the tech who sent the quote (decline-completion spec
    // §A) — before this, acceptance was only visible as an invoice quietly
    // appearing. Both UNAWAITED: they end in SMTP round trips and must never
    // delay the accept response; both swallow their own errors.
    void autoEmailAcceptedInvoice(res);
    void notifyQuoteOutcome({ quoteId: claims.quoteId, outcome: 'accepted', source: 'customer', signerName: body.signerName });
    // #8231 Sign & pay: on top of that durable url, mint the Stripe checkout for
    // the charge-now amount so the customer goes straight from signing to
    // payment. It is the PUBLIC-LINK session family (same return urls and
    // idempotency key as the invoice page's own Pay button), consumed by an
    // immediate redirect, and Stripe success/cancel both land back on the
    // durable page — not the retired one-shot payUrl. null → the page falls
    // back to invoiceUrl (no Stripe, nothing to pay, autopay, mint failure).
    const checkoutUrl = await resolveAcceptCheckoutUrl(res, invoiceUrl, {
      ip: getTrustedClientIpOrUndefined(c) ?? null, userAgent: c.req.header('user-agent') ?? null,
    });
    // #3740: with no durable invoice page to land on, the confirmation page
    // must still make payment the next step rather than a passive "accepted".
    // It shows what is due and pays through POST /:token/pay, which this
    // (now spent) token may still use because it is the token that accepted.
    const payment = payDeferred ? await readPaymentBestEffort(res.invoiceId, res.quote.orgId) : null;
    return c.json({ data: { status: res.quote.status, invoiceNumber: null, invoiceUrl, checkoutUrl, payDeferred, payment, pax8OrderId: res.pax8OrderId } });
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
  const resolved = await resolve(c); const { reason } = c.req.valid('json');
  if (!resolved) return c.json({ error: 'This link is invalid or has expired' }, 401);
  if (resolved.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds } = resolved;
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [quote] = await db.select().from(quotes).where(and(eq(quotes.id, claims.quoteId), inArray(quotes.orgId, orgIds))).limit(1);
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
    if (isPublicLinkDead(quote)) return 'superseded' as const;
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
  if (result === 'superseded') return c.json({ error: 'This quote has been replaced by a newer version', code: 'QUOTE_SUPERSEDED' }, 410);
  if (result === 'consumed') {
    // Re-arm the lost Redis marker so repeat replays die at the cheap
    // resolve() gate instead of re-reading the row each time; the durable
    // backstop holds regardless, so a failed re-arm is benign.
    try { await revokeQuoteAcceptJti(claims.jti); } catch { /* durable backstop holds */ }
    return c.json({ error: 'This link is invalid or has expired', code: 'RESPONSE_CONSUMED' }, 401);
  }
  if (result !== 'ok') return c.json({ error: 'This quote can no longer be declined', code: ERROR_CODES.CONFLICT }, 409);
  // Consume the single-use token post-commit so a declined link can't be replayed.
  // A failed revoke leaves the link replayable (security-relevant) → capture.
  try { await revokeQuoteAcceptJti(claims.jti); } catch (err) { console.error('[quotesPublic] jti revoke failed', err); captureException(err instanceof Error ? err : new Error(String(err))); }
  // Post-commit: tell the tech who sent it (with the customer's verbatim note)
  // — before this, a decline wrote the row and nobody was ever told. UNAWAITED:
  // SMTP latency must not delay the customer's response; errors are swallowed.
  void notifyQuoteOutcome({ quoteId: claims.quoteId, outcome: 'declined', source: 'customer' });
  return c.json({ data: { status: 'declined' } });
});

// ---------------------------------------------------------------------------
// Payment after acceptance (#3740)
//
// Accepting spends the token: its jti is revoked in Redis and recorded on the
// row (public_response_jti + outcome), so every route above answers 401 to it
// and a revisit of the quote link had no way back to payment. These two routes
// are the ONLY ones that tolerate a spent token, and only the token that
// accepted THIS quote. They reach exactly one thing — the quote's converted
// invoice's payment — never the proposal document, its assets, or accept /
// decline:
//   GET  /:token/payment  what is due now (display), or payment:null
//   POST /:token/pay      mint the Stripe Checkout for that invoice
// Spent-token rule: a revoked jti is accepted only when the row's durable
// consumption record names this jti with outcome 'accepted' AND the quote is
// converted. A live (unspent) token on a converted quote is accepted too — it
// is the recipient's own link and can already open the document. Everything
// else gets the same generic 401 the strict routes give.
// Tenancy: the row is matched on the signed quoteId AND the token org's merge
// chain (resolveMergedOrgIds); the invoice is the row's own
// converted_invoice_id, read and minted under the ROW's org (the mint refuses
// any invoice outside accessibleOrgIds). Signature, expiry and the org gate
// apply exactly as on every other route.
// ---------------------------------------------------------------------------

/** Verify + gate for the payment routes: like resolve(), but a revoked jti is
 *  reported (spent) instead of refused; the row decides whether it may pay. */
async function resolvePaymentAccess(c: { req: { valid: (k: 'param') => { token: string } } }): Promise<{ claims: QuoteAcceptClaims; orgIds: string[]; gate: PublicLinkOrgGate; spent: boolean } | null> {
  const { token } = c.req.valid('param');
  const claims = await verifyQuoteAcceptToken(token);
  if (!claims) return null;
  // Fails closed (true) on a Redis outage: a live token then needs the same
  // accepted-by-this-jti record a spent one does — never a wider door.
  const spent = await isQuoteAcceptJtiRevoked(claims.jti);
  const orgIds = await resolveMergedOrgIds(claims.orgId, claims.partnerId);
  const gate = await resolveQuoteLinkOrgGate(claims.quoteId, orgIds);
  return { claims, orgIds, gate, spent };
}

type PayableQuote = { orgId: string; partnerId: string; convertedInvoiceId: string };

/** The token's converted quote, or why the token may not pay through it. */
async function loadPayableQuote(
  claims: QuoteAcceptClaims, orgIds: string[], spent: boolean,
): Promise<{ ok: true; quote: PayableQuote } | { ok: false; reason: 'invalid' | 'not_converted' }> {
  const [q] = await db.select({
    ...publicLinkColumns, orgId: quotes.orgId, partnerId: quotes.partnerId,
    convertedInvoiceId: quotes.convertedInvoiceId,
    publicResponseJti: quotes.publicResponseJti, publicResponseOutcome: quotes.publicResponseOutcome,
  }).from(quotes).where(and(eq(quotes.id, claims.quoteId), inArray(quotes.orgId, orgIds))).limit(1);
  if (!q || isPublicLinkDead(q)) return { ok: false, reason: 'invalid' };
  const acceptedByThisToken = q.publicResponseOutcome === 'accepted' && q.publicResponseJti === claims.jti;
  if (spent && !acceptedByThisToken) return { ok: false, reason: 'invalid' };
  if (q.status !== 'converted' || !q.convertedInvoiceId) return { ok: false, reason: spent ? 'invalid' : 'not_converted' };
  return { ok: true, quote: { orgId: q.orgId, partnerId: q.partnerId, convertedInvoiceId: q.convertedInvoiceId } };
}

const invalidLink = { error: 'This link is invalid or has expired' } as const;
const notConverted = { error: 'This proposal has not been accepted yet', code: 'NOT_CONVERTED' } as const;

/** Display read for the payment step. A failure only hides the Pay button
 *  (the page then points at the partner), so it is captured, not thrown. */
async function readPaymentBestEffort(invoiceId: string, orgId: string): Promise<ConvertedQuotePayment | null> {
  try {
    return await getConvertedInvoicePayment(invoiceId, orgId);
  } catch (err) {
    console.error('[quotesPublic] converted-invoice payment read failed', { invoiceId, err });
    captureException(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

/** Per-invoice cap on Checkout mints from the quote link. Same Redis bucket as
 *  the public invoice page's Pay (invoice-public:pay:<invoiceId>), so the two
 *  surfaces share one budget. Fail-open on a Redis outage, as there: the mint
 *  is idempotency-keyed, so availability wins over a strict cap. */
async function overPublicPayLimit(invoiceId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return !(await rateLimiter(redis, `invoice-public:pay:${invoiceId}`, 10, 60)).allowed;
  } catch {
    return false;
  }
}

// GET /:token/payment — what the accepted quote's invoice would charge now.
quotesPublicRoutes.get('/:token/payment', zValidator('param', tokenParam), async (c) => {
  applyPublicLinkHeaders(c);
  const access = await resolvePaymentAccess(c);
  if (!access) return c.json(invalidLink, 401);
  if (access.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds, spent } = access;
  const loaded = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const r = await loadPayableQuote(claims, orgIds, spent);
    if (!r.ok) return r;
    const [p] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, r.quote.partnerId)).limit(1);
    return { ...r, partnerName: p?.name ?? null };
  }));
  if (!loaded.ok) return loaded.reason === 'not_converted' ? c.json(notConverted, 409) : c.json(invalidLink, 401);
  // Read AFTER the context above closed: it opens its own.
  const payment = await readPaymentBestEffort(loaded.quote.convertedInvoiceId, loaded.quote.orgId);
  return c.json({ data: { partnerName: loaded.partnerName, payment } });
});

// POST /:token/pay — mint the Stripe Checkout for the accepted quote's invoice.
// The PUBLIC-LINK session family (publicInvoiceCheckoutUrls): session-id-only
// return urls landing on the invoice's durable page, and the same idempotency
// key as Sign & pay and the invoice page's own Pay, so the three never mint
// competing sessions for one charge.
quotesPublicRoutes.post('/:token/pay', zValidator('param', tokenParam), async (c) => {
  applyPublicLinkHeaders(c);
  // Same-origin fetch shape (as /invoices/public/:token/pay): a cross-site form
  // cannot set a JSON content type, and there is no ambient credential anyway.
  if (!(c.req.header('content-type') ?? '').includes('application/json')) {
    return c.json({ error: 'Invalid request' }, 400);
  }
  const access = await resolvePaymentAccess(c);
  if (!access) return c.json(invalidLink, 401);
  if (access.gate.blocked) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  const { claims, orgIds, spent } = access;
  const loaded = await runOutsideDbContext(() => withSystemDbAccessContext(() => loadPayableQuote(claims, orgIds, spent)));
  if (!loaded.ok) return loaded.reason === 'not_converted' ? c.json(notConverted, 409) : c.json(invalidLink, 401);
  const { quote } = loaded;
  if (await overPublicPayLimit(quote.convertedInvoiceId)) return c.json({ error: 'Too many requests', code: ERROR_CODES.RATE_LIMITED }, 429);
  try {
    // createInvoicePayLink owns every payment guard (org access, PAYABLE,
    // collection in progress / held money, pending revocation, charge-now > 0,
    // Stripe connected) and opens its own short DB contexts — none is held here.
    const link = await createInvoicePayLink(
      quote.convertedInvoiceId,
      { userId: null, partnerId: null, accessibleOrgIds: [quote.orgId] },
      { ...publicInvoiceCheckoutUrls(), ip: getTrustedClientIpOrUndefined(c) ?? null, userAgent: c.req.header('user-agent') ?? null },
    );
    return c.json({ data: { url: link.url } });
  } catch (err) {
    if (err instanceof InvoiceServiceError) {
      // Customer-facing wording, as on the public invoice page: never name the
      // partner's Stripe setup to their customer.
      if (err.code === 'COLLECTION_IN_PROGRESS') return c.json({ error: 'A payment is already processing', code: err.code }, 409);
      if (err.code === 'STRIPE_NOT_CONNECTED') {
        return c.json({ error: 'Online payment is not available for this invoice — please contact the sender', code: err.code }, 409);
      }
      if (err.code === 'STRIPE_CURRENCY_UNSUPPORTED') return c.json({ error: CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE, code: err.code }, 409);
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    throw err;
  }
});
