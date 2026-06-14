import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getInvoice } from '../../services/invoiceService';
import { getInvoicePdf, renderInvoicePdf } from '../../services/invoicePdf';
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
      await renderInvoicePdf(id);
      pdf = await getInvoicePdf(id);
    }
    if (!pdf) return c.json({ error: 'Failed to generate invoice PDF' }, 500);

    const filename = `${invoice.invoiceNumber ?? invoice.id}.pdf`;
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
