import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { and, eq } from 'drizzle-orm';
import { computeChargeNow } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { invoices, invoiceLines, invoiceStripePayments } from '../db/schema';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { resolveInvoiceByLinkToken, getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../services/invoiceLinkToken';
import { toCustomerInvoiceHeader, toCustomerInvoiceLine, markViewed } from '../services/invoiceService';
import { getInvoicePdf, renderInvoicePdf } from '../services/invoicePdf';
import { createInvoicePayLink } from '../services/invoiceCheckout';
import { CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE } from '../services/stripeCheckoutErrors';
import { settleCheckoutSession } from '../services/stripeSettle';
import { InvoiceServiceError } from '../services/invoiceTypes';
import { safeContentDispositionFilename } from '../utils/httpHeaders';
import { resolveThemeId, resolvePageSize } from '../services/documentThemes';
import { portalBase } from '../services/portalUrl';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { resolveOrgLinkGate, PUBLIC_LINK_ORG_UNAVAILABLE } from '../services/publicLinkOrgGate';

/**
 * Unauthenticated, token-gated PUBLIC INVOICE surface — the customer's durable
 * no-login view-and-pay link (spec: docs/superpowers/specs/billing/
 * 2026-08-21-public-invoice-pay-link-design.md). Twin of quotesPublic.ts.
 *
 * SECURITY: this router has NO auth middleware, so every DB op runs through
 * runOutsideDbContext(() => withSystemDbAccessContext(...)). The bearer token
 * is the only authorization: the invoice is resolved BY token hash
 * (invoiceLinkToken.resolveInvoiceByLinkToken — expiry + non-draft enforced
 * there), and every subsequent read/write is scoped to the resolved row's
 * id/org_id. Mounted at /invoices/public BEFORE the auth-gated /invoices
 * router in index.ts (same ordering trick as /quotes/public).
 *
 * Responses carry no-store / no-referrer / noindex headers: the URL itself is
 * the capability, so it must never land in caches, referrer logs, or crawlers.
 */

const tokenParam = z.object({ token: z.string().min(20).max(128) });
const settleReturnSchema = z.object({ sessionId: z.string().trim().min(1).max(255) });

/** Invoice statuses that may be paid online — mirrors the portal PAYABLE set. */
const PAYABLE = new Set(['sent', 'partially_paid', 'overdue']);

/** How long after settlement the return endpoint will still hand out the
 *  invoice's public URL (bounds the session-id → url exchange). */
const SETTLE_RETURN_URL_WINDOW_MS = 60 * 60 * 1000;

function applyPublicLinkHeaders(c: { header: (k: string, v: string) => void }): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

/**
 * Per-key limiter for the Stripe-backed mutations (the isolated per-IP bucket
 * in globalRateLimit caps the surface as a whole; this bounds a single
 * token/session being hammered from many IPs). Delegates to the MULTI-atomic
 * sliding-window rateLimiter — a hand-rolled INCR-then-EXPIRE here could
 * strand a TTL-less counter that 429s an invoice's Pay button forever. The
 * one policy difference: FAIL-OPEN on Redis outage (rateLimiter itself fails
 * closed) — /pay is idempotency-keyed and /settle-return is idempotent, so
 * availability wins over a strict cap.
 */
async function overPublicOpLimit(kind: string, key: string, limit: number, windowSeconds = 60): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const result = await rateLimiter(redis, `invoice-public:${kind}:${key}`, limit, windowSeconds);
    return !result.allowed;
  } catch {
    return false;
  }
}

const invalidLink = { error: 'This link is invalid or has expired' } as const;

type ResolvedInvoice = NonNullable<Awaited<ReturnType<typeof resolveInvoiceByLinkToken>>>;

/** Resolve the token inside a system context, or null. */
async function resolve(token: string): Promise<ResolvedInvoice | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => resolveInvoiceByLinkToken(token)));
}

/**
 * Org-lifecycle gate (Wave 4): this durable bearer link outlives an archive, so
 * every handler re-checks the CURRENT owning tenant with ONE system-context
 * read before serving or writing. `inv.orgId` is already the post-merge org, so
 * a merged-away invoice gates on its survivor. Reads gate too — an archived
 * tenant's invoice must read as gone, not as a payable document.
 */
async function orgLinkGone(inv: { orgId: string }): Promise<boolean> {
  return (await resolveOrgLinkGate(inv.orgId)).blocked;
}

export const invoicesPublicRoutes = new Hono();

// GET /:token — the customer view. One generic 401 for unknown/expired/draft
// (no existence leak). Void invoices resolve but render the no-amounts state.
invoicesPublicRoutes.get('/:token', zValidator('param', tokenParam), async (c) => {
  applyPublicLinkHeaders(c);
  const inv = await resolve(c.req.valid('param').token);
  if (!inv) return c.json(invalidLink, 401);
  if (await orgLinkGone(inv)) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);

  const data = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [partner] = await db.select({
      name: partners.name, billingEmail: partners.billingEmail,
      documentTheme: partners.documentTheme, documentPageSize: partners.documentPageSize,
    }).from(partners).where(eq(partners.id, inv.partnerId)).limit(1);
    const [brand] = await db.select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
      .from(portalBranding).where(eq(portalBranding.orgId, inv.orgId)).limit(1);

    // Void: the calm no-amounts state — status + who to contact, nothing else.
    if (inv.status === 'void') {
      return {
        invoice: {
          id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status,
          replaced: inv.replacedByInvoiceId != null,
        },
        lines: [], chargeNow: null, payable: false,
        branding: brandingBlock(partner, brand),
      };
    }

    const rows = await db.select({
      name: invoiceLines.name, description: invoiceLines.description,
      quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice,
      taxable: invoiceLines.taxable, lineTotal: invoiceLines.lineTotal,
    }).from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, inv.id), eq(invoiceLines.customerVisible, true)))
      .orderBy(invoiceLines.sortOrder);

    // "Link fetched" stamp — an email scanner can trigger this, so it is a
    // signal, not proof of human viewing. Best-effort; never fails the render.
    try { await markViewed(inv.id, inv.orgId); } catch (err) {
      console.error('[invoicesPublic] markViewed failed', { invoiceId: inv.id, err });
    }

    const chargeNow = computeChargeNow({
      depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance,
    });
    return {
      invoice: { ...toCustomerInvoiceHeader(inv), paidAt: inv.paidAt },
      lines: rows.map(toCustomerInvoiceLine),
      chargeNow,
      payable: PAYABLE.has(inv.status) && Number(inv.balance) > 0,
      branding: brandingBlock(partner, brand),
    };
  }));
  return c.json({ data });
});

function brandingBlock(
  partner: { name: string; billingEmail: string | null; documentTheme: string | null; documentPageSize: string | null } | undefined,
  brand: { logoUrl: string | null; primaryColor: string | null } | undefined,
) {
  return {
    partnerName: partner?.name ?? 'Invoice',
    contactEmail: partner?.billingEmail ?? null,
    logoUrl: brand?.logoUrl ?? null,
    primaryColor: brand?.primaryColor ?? null,
    theme: resolveThemeId(partner?.documentTheme),
    pageSize: resolvePageSize(partner?.documentPageSize),
  };
}

// GET /:token/pdf — stream the stored PDF (render on demand if absent).
invoicesPublicRoutes.get('/:token/pdf', zValidator('param', tokenParam), async (c) => {
  applyPublicLinkHeaders(c);
  const inv = await resolve(c.req.valid('param').token);
  if (!inv) return c.json(invalidLink, 401);
  if (await orgLinkGone(inv)) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  if (inv.status === 'void') return c.json({ error: 'This invoice is no longer available' }, 409);
  if (await overPublicOpLimit('pdf', inv.id, 10)) return c.json({ error: 'Too many requests' }, 429);

  // System context like every other handler here — these reads/renders run
  // with NO auth middleware, so a bare call would execute without a DB access
  // context and RLS would return zero rows (500 on every public download).
  const pdf = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    let bytes = await getInvoicePdf(inv.id);
    if (!bytes) {
      await renderInvoicePdf(inv.id);
      bytes = await getInvoicePdf(inv.id);
    }
    return bytes;
  }));
  if (!pdf) return c.json({ error: 'Failed to generate invoice PDF' }, 500);
  const filename = safeContentDispositionFilename(`${inv.invoiceNumber || `invoice-${inv.id}`}.pdf`);
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
});

// POST /:token/pay — mint a Stripe hosted-checkout session for the amount due
// now (deposit-aware). Return URLs carry ONLY the session id — the durable
// bearer token must never reach Stripe's logs (spec §5); the return page
// exchanges the session id back into the public URL via /settle-return.
invoicesPublicRoutes.post('/:token/pay', zValidator('param', tokenParam), async (c) => {
  applyPublicLinkHeaders(c);
  // Same-origin fetch shape: the page always POSTs JSON. A cross-site form
  // can't set this header, and there is no ambient credential to ride anyway.
  if (!(c.req.header('content-type') ?? '').includes('application/json')) {
    return c.json({ error: 'Invalid request' }, 400);
  }
  const inv = await resolve(c.req.valid('param').token);
  if (!inv) return c.json(invalidLink, 401);
  if (await orgLinkGone(inv)) return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  if (await overPublicOpLimit('pay', inv.id, 10)) return c.json({ error: 'Too many requests' }, 429);

  const returnBase = `${portalBase()}/invoice/return`;
  try {
    // #1448 — NOT wrapped in withSystemDbAccessContext: createInvoicePayLink opens
    // its own short system contexts around each DB step and runs
    // checkout.sessions.create outside any transaction. An enclosing context here
    // pinned a pooled connection idle-in-transaction across the Stripe
    // round-trip (#3777 review F2). runOutsideDbContext is kept only so a
    // stray ambient context can never be inherited.
    const link = await runOutsideDbContext(() =>
      createInvoicePayLink(inv.id, { userId: null, partnerId: null, accessibleOrgIds: [inv.orgId] }, {
        successUrl: `${returnBase}?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${returnBase}?canceled=1&session_id={CHECKOUT_SESSION_ID}`,
        idempotencySuffix: '_pub',
      }));
    return c.json({ data: { url: link.url } });
  } catch (err) {
    if (err instanceof InvoiceServiceError) {
      // Customer-facing wording for the benign 409s.
      if (err.code === 'STRIPE_NOT_CONNECTED') {
        return c.json({ error: 'Online payment is not available for this invoice — please contact the sender', code: err.code }, 409);
      }
      // The partner-facing message names their Stripe account setup — never
      // leak it to the customer (spec §10).
      if (err.code === 'STRIPE_CURRENCY_UNSUPPORTED') {
        return c.json({ error: CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE, code: err.code }, 409);
      }
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    throw err;
  }
});

// POST /settle-return — verify-on-return WITHOUT the invoice token: the customer
// lands on <portal>/invoice/return?session_id=cs_… after Checkout. The session
// id (unguessable, ours, recent) is exchanged for settlement + the canonical
// public URL so the browser can land back on the durable page. Idempotent.
invoicesPublicRoutes.post('/settle-return', zValidator('json', settleReturnSchema), async (c) => {
  applyPublicLinkHeaders(c);
  const { sessionId } = c.req.valid('json');
  if (await overPublicOpLimit('settle', sessionId, 20)) return c.json({ error: 'Too many requests' }, 429);

  const result = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // The session must be one WE created — the mapping row is the authority.
    const [mapping] = await db.select({
      invoiceId: invoiceStripePayments.invoiceId,
      status: invoiceStripePayments.status,
      updatedAt: invoiceStripePayments.updatedAt,
    }).from(invoiceStripePayments)
      .where(and(
        eq(invoiceStripePayments.stripeObjectId, sessionId),
        eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      )).limit(1);
    if (!mapping) return null;

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
    if (!inv) return null;

    // Org-lifecycle gate, checked BEFORE settling: this handler has no token,
    // so the invoice row is the only thing that names the tenant. The gate
    // reuses THIS system transaction (resolveOrgLinkGate escalates only from a
    // narrower ambient context), so no second connection is pinned across it.
    if ((await resolveOrgLinkGate(inv.orgId)).blocked) return 'org_gone' as const;

    // Only an actual SUCCESS is "settled" — a failed/refunded mapping is also
    // not-pending, and reporting settled:true for those would paint a
    // "Payment received" banner over a payment that failed or was refunded.
    const alreadySettled = mapping.status === 'succeeded';
    const terminalNonSuccess = mapping.status !== 'pending' && !alreadySettled;
    let settled = alreadySettled;
    let justSettled = false;
    if (!alreadySettled && !terminalNonSuccess) {
      try {
        ({ settled } = await settleCheckoutSession(inv.partnerId, sessionId));
        justSettled = settled;
      } catch (err) {
        // Never strand the customer — the reconcile sweep settles it within the
        // minute; report unsettled so the page shows "confirming payment".
        console.error('[invoicesPublic] settle-return failed', { invoiceId: inv.id, sessionId, err });
        settled = false;
      }
    }

    // Bound the session-id → url exchange: a customer mid-flow (pending
    // mapping), a settlement completed just now, or one recorded within the
    // window may recover the page URL. A stale long-settled session may NOT —
    // otherwise any old session id would remain a permanent url oracle.
    const recent = mapping.status === 'pending'
      || justSettled
      || (mapping.updatedAt != null && Date.now() - mapping.updatedAt.getTime() <= SETTLE_RETURN_URL_WINDOW_MS);
    let publicUrl: string | null = null;
    if (recent) {
      try {
        const link = await getOrMintInvoiceLink({
          id: inv.id, dueDate: inv.dueDate,
          publicLinkTokenHash: inv.publicLinkTokenHash,
          publicLinkTokenCt: inv.publicLinkTokenCt,
          publicLinkExpiresAt: inv.publicLinkExpiresAt,
        });
        publicUrl = buildPublicInvoiceUrl(link.token);
      } catch (err) {
        console.error('[invoicesPublic] could not resolve public url on return', { invoiceId: inv.id, err });
      }
    }
    return { settled, publicUrl };
  }));

  if (result === 'org_gone') return c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410);
  if (!result) return c.json({ error: 'Unknown payment session' }, 404);
  return c.json({ data: result });
});
