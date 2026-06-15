import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { invoices } from '../../db/schema';
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
