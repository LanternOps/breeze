import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceStripePayments } from '../../db/schema';
import { listSchema, ticketParamSchema } from './schemas';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  getPagination,
  isEtagFresh,
} from './helpers';
import { getCustomerInvoice, markViewed } from '../../services/invoiceService';
import { getInvoicePdf, renderInvoicePdf } from '../../services/invoicePdf';
import { portalBase } from '../../services/portalUrl';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { getPartnerStripeClient, PartnerStripeError } from '../../services/partnerStripe';
import { settleCheckoutSession } from '../../services/stripeSettle';
import { toMinorUnits } from '../../services/stripeMoney';
import { computeChargeNow } from '@breeze/shared';

// The Checkout session id Stripe substitutes into success_url ({CHECKOUT_SESSION_ID}).
const settleSchema = z.object({ sessionId: z.string().trim().min(1).max(255) });

// Invoice statuses that may be paid online. Drafts/paid/void are excluded.
const PAYABLE = new Set(['sent', 'partially_paid', 'overdue']);

export const invoiceRoutes = new Hono();

// GET /portal/invoices — this org's issued (status != 'draft') invoices.
// Drafts are MSP-internal and must never surface to the customer.
invoiceRoutes.get('/invoices', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  const conditions = and(eq(invoices.orgId, auth.user.orgId), ne(invoices.status, 'draft'));

  const countResult = await db.select({ count: sql<number>`count(*)` }).from(invoices).where(conditions);
  const total = Number(countResult[0]?.count ?? 0);

  const data = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      currencyCode: invoices.currencyCode,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      balance: invoices.balance,
      depositDue: invoices.depositDue,
    })
    .from(invoices)
    .where(conditions)
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt))
    .limit(limit)
    .offset(offset);

  const payload = { data, pagination: { page, limit, total } };

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 15,
    staleWhileRevalidateSeconds: 90,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
});

// GET /portal/invoices/:id — the customer view (visible lines only). Passing the
// portal user's org id to the service guard enforces tenant isolation (404, not
// 403, so we don't leak existence cross-tenant). markViewed stamps the open.
invoiceRoutes.get('/invoices/:id', zValidator('param', ticketParamSchema), async (c) => {
  const auth = c.get('portalAuth');
  const { id } = c.req.valid('param');

  let result: Awaited<ReturnType<typeof getCustomerInvoice>>;
  try {
    result = await getCustomerInvoice(id, auth.user.orgId);
  } catch (err) {
    if (err instanceof InvoiceServiceError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  // Drafts are never customer-visible even though getCustomerInvoice is org-scoped.
  if (result.invoice.status === 'draft') return c.json({ error: 'Invoice not found' }, 404);

  // Best-effort view stamp — never fail the read if the stamp write hiccups.
  try {
    await markViewed(id, auth.user.orgId);
  } catch (err) {
    console.error('[portal] markViewed failed', { invoiceId: id, orgId: auth.user.orgId, err });
  }

  return c.json({ invoice: result.invoice, lines: result.lines });
});

// GET /portal/invoices/:id/pdf — stream the stored PDF (render on demand if absent).
invoiceRoutes.get('/invoices/:id/pdf', zValidator('param', ticketParamSchema), async (c) => {
  const auth = c.get('portalAuth');
  const { id } = c.req.valid('param');

  // Org-guard via the service (404 cross-tenant); also blocks draft PDFs.
  let invoice: Awaited<ReturnType<typeof getCustomerInvoice>>['invoice'];
  try {
    invoice = (await getCustomerInvoice(id, auth.user.orgId)).invoice;
  } catch (err) {
    if (err instanceof InvoiceServiceError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  if (invoice.status === 'draft') return c.json({ error: 'Invoice not found' }, 404);

  let pdf = await getInvoicePdf(id);
  if (!pdf) {
    await renderInvoicePdf(id);
    pdf = await getInvoicePdf(id);
  }
  if (!pdf) return c.json({ error: 'Failed to generate invoice PDF' }, 500);

  // invoice_number is partner-controlled (invoice_number_prefix); sanitize it
  // before embedding in the Content-Disposition header to block CRLF injection.
  const filename = safeContentDispositionFilename(`${invoice.invoiceNumber || `invoice-${invoice.id}`}.pdf`);
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdf.length),
    },
  });
});

// POST /portal/invoices/:id/pay — open a Stripe Checkout session on the partner's
// OWN Stripe account using their stored API key (no Connect).
//
// #1448 — this route opts out of the auth middleware's auto request-transaction
// (see selfManagedDbContextRoutes.ts), so there is NO ambient DB context here.
// Each DB step opens its own short `withSystemDbAccessContext` and the slow
// Stripe HTTP call runs OUTSIDE any transaction, so a pooled connection is never
// held idle across the network round-trip (#1105 class). Tenant isolation does
// not rely on RLS scope: the invoice SELECT is explicitly filtered to the
// authenticated `auth.user.orgId`, and the mapping INSERT runs inside a context
// so it isn't a contextless 0-row no-op (#1375).
invoiceRoutes.post('/invoices/:id/pay', zValidator('param', ticketParamSchema), async (c) => {
  const auth = c.get('portalAuth');
  const { id } = c.req.valid('param');

  const [inv] = await withSystemDbAccessContext(() =>
    db.select().from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.orgId, auth.user.orgId), ne(invoices.status, 'draft')))
      .limit(1)
  );
  if (!inv) return c.json({ error: 'Invoice not found' }, 404);
  if (!PAYABLE.has(inv.status)) return c.json({ error: 'Invoice is not payable' }, 409);

  // Deposit-first: charge the deposit remaining while unmet, else the full
  // balance. computeChargeNow clamps to balance and handles every state (no
  // deposit, deposit partially/fully paid) — never reimplement that logic here.
  const chargeNow = computeChargeNow({
    depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance,
  });
  // Currency-aware minor units: zero-decimal currencies (JPY, KRW, …) must NOT be
  // multiplied by 100, or the customer is over-charged 100x (see stripeMoney.ts).
  const chargeMinor = toMinorUnits(chargeNow.amount, inv.currencyCode);
  if (chargeMinor <= 0) return c.json({ error: 'Nothing to pay' }, 409);

  // stripe_connect_accounts is a partner-axis table (reused by the #1610 API-key
  // model). This handler runs with NO ambient DB context (#1448 opt-out), and even
  // when it did it ran under the portal user's ORGANIZATION scope, where
  // breeze_has_partner_access is false — a bare read would be silently RLS-filtered
  // to 0 rows with no error (the #1375 class), making the pay route always 409. Read
  // the partner's key + build their client in a short system-scoped context (a no-op
  // nest if a context is somehow already active).
  let stripe: Awaited<ReturnType<typeof getPartnerStripeClient>>['stripe'];
  let stripeAccountId: string;
  try {
    ({ stripe, stripeAccountId } = await withSystemDbAccessContext(() =>
      getPartnerStripeClient(inv.partnerId)));
  } catch (err) {
    // "No key configured" is a benign 409 (partner hasn't set up online payment).
    // A decrypt/unreadable-key fault is a real 500 — don't lie "not available" when
    // the key is actually corrupt/misconfigured (it's already logged in the service).
    if (err instanceof PartnerStripeError && err.code === 'NO_STRIPE_KEY') {
      return c.json({ error: 'Online payment is not available' }, 409);
    }
    if (err instanceof PartnerStripeError) {
      return c.json({ error: 'Could not initialize payment — please contact support' }, 500);
    }
    // Unexpected (non-PartnerStripeError) — e.g. a DB/context failure from the
    // wrapping read. Log it before rethrowing so it isn't an opaque 500.
    console.error('[portal/invoices] failed to initialize partner Stripe client', { partnerId: inv.partnerId, err });
    throw err;
  }

  // Customer-facing portal base URL (shared resolution — includes the portal
  // base path, so it is no longer hand-appended in the URLs below).
  const portalBaseUrl = portalBase();

  // Truly outside any DB context/transaction — no pooled connection is held
  // across this ~hundreds-of-ms round trip.
  const session = await runOutsideDbContext(() => stripe.checkout.sessions.create({
    mode: 'payment',
    // v1 is card-only. Restricting payment_method_types keeps the recorded
    // invoice_payments.method ('card') accurate and avoids enabling async/
    // delayed-settlement methods (which would land as 'unpaid' on completion).
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: inv.currencyCode.toLowerCase(),
        unit_amount: chargeMinor,
        product_data: {
          name: chargeNow.isDeposit
            ? `Deposit — Invoice ${inv.invoiceNumber ?? inv.id}`
            : `Invoice ${inv.invoiceNumber ?? inv.id}`,
        },
      },
      quantity: 1,
    }],
    // {CHECKOUT_SESSION_ID} is substituted by Stripe on redirect — the verify-on-return
    // handler reads it to settle server-side (the API-key model has no inbound webhook).
    success_url: `${portalBaseUrl}/invoices/${inv.id}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${portalBaseUrl}/invoices/${inv.id}`,
    metadata: {
      invoice_id: inv.id,
      org_id: inv.orgId,
      partner_id: inv.partnerId,
      // Historically the full balance; now the amount actually charged in THIS
      // session (deposit or balance). Write-only — the settle path (stripeSettle.ts)
      // records what Stripe reports paid via session.amount_total, never this field.
      invoice_balance_cents: String(chargeMinor),
    },
  }, {
    // Dedupe double-click / retry: identical (invoice, charge-now amount, phase) reuses
    // the same Checkout session instead of creating a second pending mapping row. A
    // 50%-deposit invoice has the SAME chargeMinor for the deposit and the later
    // balance charge (different product name but equal amount), so the amount alone
    // can't disambiguate — the explicit dep/bal discriminator does.
    idempotencyKey: `inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit ? 'dep' : 'bal'}`,
  }));

  // Fresh short context so the pending-mapping write isn't a contextless 0-row
  // no-op under forced-RLS breeze_app (#1375).
  await withSystemDbAccessContext(() =>
    db.insert(invoiceStripePayments).values({
      orgId: inv.orgId,
      invoiceId: inv.id,
      stripeAccountId,
      stripeObjectType: 'checkout_session',
      stripeObjectId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      amount: chargeNow.amount,
      currency: inv.currencyCode,
      status: 'pending',
    })
  );

  return c.json({ url: session.url });
});

// POST /portal/invoices/:id/settle — verify-on-return: the customer just came back
// from Checkout (success_url carries &session_id={CHECKOUT_SESSION_ID}). Settle the
// payment server-side NOW for instant feedback. The API-key model has no inbound
// webhook, so the reconcile sweep is the eventual backstop — this is the fast path,
// and it is idempotent (safe to call twice / alongside the sweep).
invoiceRoutes.post('/invoices/:id/settle',
  zValidator('param', ticketParamSchema),
  zValidator('json', settleSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const { id } = c.req.valid('param');
    const { sessionId } = c.req.valid('json');

    // Org-scoped: the invoice must belong to this portal user's org (404, not 403,
    // so we don't leak existence cross-tenant).
    const [inv] = await db.select({ id: invoices.id, partnerId: invoices.partnerId })
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.orgId, auth.user.orgId), ne(invoices.status, 'draft')))
      .limit(1);
    if (!inv) return c.json({ error: 'Invoice not found' }, 404);

    // The session must be one WE created for THIS invoice — a pending/recorded
    // mapping row, read in org scope (RLS confirms ownership). This blocks a customer
    // from passing a foreign session_id to settle (and reveal) someone else's checkout.
    const [mapping] = await db.select({ id: invoiceStripePayments.id })
      .from(invoiceStripePayments)
      .where(and(
        eq(invoiceStripePayments.stripeObjectId, sessionId),
        eq(invoiceStripePayments.invoiceId, inv.id),
        eq(invoiceStripePayments.orgId, auth.user.orgId),
      ))
      .limit(1);
    if (!mapping) return c.json({ settled: false });

    // settleCheckoutSession reads the partner-axis key + records the payment — both
    // need system scope (the portal request runs in ORG scope, where the key row is
    // RLS-invisible — the #1375 class). The service expects the caller to establish it.
    try {
      const result = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => settleCheckoutSession(inv.partnerId, sessionId)));
      return c.json(result);
    } catch (err) {
      // Never strand the customer on an error just because instant-settle hiccuped —
      // the sweep settles it within the minute. Log + report unsettled (200), so the
      // page can show "processing" rather than a failure.
      console.error('[portal] verify-on-return settle failed', { invoiceId: inv.id, sessionId, err });
      return c.json({ settled: false });
    }
  });
