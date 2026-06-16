import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
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
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { getConnection } from '../../services/stripeConnectService';
import { getStripe, getConnectedStripeOptions } from '../../services/stripeClient';
import { toMinorUnits } from '../../services/stripeMoney';

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
// connected account (direct charge). The invoice SELECT and the mapping INSERT run
// under the customer's org context (RLS-safe as that org); the partner-axis
// connected-account read escapes to a system sub-context (see below).
invoiceRoutes.post('/invoices/:id/pay', zValidator('param', ticketParamSchema), async (c) => {
  const auth = c.get('portalAuth');
  const { id } = c.req.valid('param');

  const [inv] = await db.select().from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, auth.user.orgId), ne(invoices.status, 'draft')))
    .limit(1);
  if (!inv) return c.json({ error: 'Invoice not found' }, 404);
  if (!PAYABLE.has(inv.status)) return c.json({ error: 'Invoice is not payable' }, 409);

  // Currency-aware minor units: zero-decimal currencies (JPY, KRW, …) must NOT be
  // multiplied by 100, or the customer is over-charged 100x (see stripeMoney.ts).
  const balanceMinor = toMinorUnits(inv.balance, inv.currencyCode);
  if (balanceMinor <= 0) return c.json({ error: 'Nothing to pay' }, 409);

  // stripe_connect_accounts is a partner-axis table. This handler runs under the
  // portal user's ORGANIZATION scope (portal/auth.ts), where breeze_has_partner_access
  // is false — a bare org-scope read would be silently RLS-filtered to 0 rows with no
  // error (the #1375 class of bug), making the pay route always 409. Read the partner's
  // connection in a system-scoped sub-context outside the request transaction.
  const conn = await runOutsideDbContext(() => withSystemDbAccessContext(() => getConnection(inv.partnerId)));
  if (!conn || conn.status !== 'connected') {
    return c.json({ error: 'Online payment is not available' }, 409);
  }

  // Customer-facing portal base URL (mirrors invoicePdf.ts portal-link building).
  const portalBase = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || 'http://localhost:4321').replace(/\/$/, '');

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    // v1 is card-only. Restricting payment_method_types keeps the recorded
    // invoice_payments.method ('card') accurate and avoids enabling async/
    // delayed-settlement methods (which would land as 'unpaid' on completion).
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: inv.currencyCode.toLowerCase(),
        unit_amount: balanceMinor,
        product_data: { name: `Invoice ${inv.invoiceNumber ?? inv.id}` },
      },
      quantity: 1,
    }],
    success_url: `${portalBase}/portal/invoices/${inv.id}?paid=1`,
    cancel_url: `${portalBase}/portal/invoices/${inv.id}`,
    metadata: {
      invoice_id: inv.id,
      org_id: inv.orgId,
      partner_id: inv.partnerId,
      invoice_balance_cents: String(balanceMinor),
    },
  }, {
    ...getConnectedStripeOptions(conn.stripeAccountId),
    // Dedupe double-click / retry: identical (invoice, balance) reuses the same
    // Checkout session instead of creating a second pending mapping row.
    idempotencyKey: `inv_${inv.id}_${balanceMinor}`,
  });

  await db.insert(invoiceStripePayments).values({
    orgId: inv.orgId,
    invoiceId: inv.id,
    stripeAccountId: conn.stripeAccountId,
    stripeObjectType: 'checkout_session',
    stripeObjectId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    amount: Number(inv.balance).toFixed(2),
    currency: inv.currencyCode,
    status: 'pending',
  });

  return c.json({ url: session.url });
});
