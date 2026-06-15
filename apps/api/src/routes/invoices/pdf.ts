import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getInvoice } from '../../services/invoiceService';
import { getInvoicePdf, renderInvoicePdf } from '../../services/invoicePdf';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoicePdfRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const exportPerm = requirePermission(PERMISSIONS.INVOICES_EXPORT.resource, PERMISSIONS.INVOICES_EXPORT.action);
const idParam = z.object({ id: z.string().uuid() });

// GET /:id/pdf — stream the stored invoice PDF, rendering on demand if absent.
// getInvoice() enforces the org-access guard (404 on cross-tenant); the bytea is
// returned as an application/pdf attachment named "<invoiceNumber>.pdf".
invoicePdfRoutes.get('/:id/pdf', scopes, exportPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const { invoice } = await getInvoice(id, invoiceActorFrom(c));
    let pdf = await getInvoicePdf(id);
    if (!pdf) {
      // Drafts are preview-only: renderInvoicePdf does NOT persist them, so fall
      // back to the bytes off the render result rather than re-reading the (empty)
      // store. Issued invoices persist, so the read-back path still works too.
      const rendered = await renderInvoicePdf(id);
      pdf = (await getInvoicePdf(id)) ?? rendered.pdf;
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
  } catch (err) {
    return handleServiceError(c, err);
  }
});
