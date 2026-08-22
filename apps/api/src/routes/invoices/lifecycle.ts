import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { sendComposerSchema, parseComposerBody } from '../../lib/sendComposer';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { voidInvoiceSchema } from '@breeze/shared';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';
import { sendInvoiceEmail, resendInvoiceEmail, type SendInvoiceEmailOptions } from '../../services/invoicePdf'; // added in Phase 5
import { writeRouteAudit } from '../../services/auditEvents';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);
const idParam = z.object({ id: z.string().guid() });

/** Map the validated composer body onto the service options. Blank strings
 *  collapse to undefined so an empty Subject/Message field means "use the
 *  default" rather than sending an empty subject line. */
function composerOptions(body: Partial<z.infer<typeof sendComposerSchema>>): SendInvoiceEmailOptions {
  return {
    message: body.message || undefined,
    to: body.to,
    cc: body.cc,
    subject: body.subject || undefined,
    includePdf: body.includePdf,
  };
}

invoiceLifecycleRoutes.post('/:id/issue', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await issueInvoice(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});

// POST /:id/send — issue (if still a draft) + email. The composer body is
// optional and shared with /resend: bulk-send, the MCP tools and the contract
// worker POST nothing and get the classic billing-contact send unchanged.
invoiceLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const parsed = await parseComposerBody(c, sendComposerSchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try { return c.json({ data: await sendInvoiceEmail(c.req.valid('param').id, invoiceActorFrom(c), composerOptions(parsed.data)) }); }
  catch (err) { return handleServiceError(c, err); }
});

// POST /:id/resend — re-email an already-issued invoice. Not a second send:
// sent_at, the invoice number and the issue-time snapshots stay pinned to the
// original issue and no invoice.sent event is re-emitted (see
// resendInvoiceEmail). Same invoices:send permission as /send, and audited on
// every call — it puts a demand for money back in a customer's inbox.
invoiceLifecycleRoutes.post('/:id/resend', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  const parsed = await parseComposerBody(c, sendComposerSchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const result = await resendInvoiceEmail(id, invoiceActorFrom(c), composerOptions(parsed.data));
    writeRouteAudit(c, {
      orgId: result.invoice.orgId,
      action: 'invoice.resend',
      resourceType: 'invoice',
      resourceId: id,
      result: result.emailed ? 'success' : 'failure',
      // recipientCount, not the addresses: the audit log is queryable by
      // support and a customer's email address is not incident data.
      details: { emailed: result.emailed, emailReason: result.reason, recipientCount: result.recipients.length },
    });
    return c.json({ data: result });
  } catch (err) { return handleServiceError(c, err); }
});

invoiceLifecycleRoutes.post('/:id/void', scopes, sendPerm, zValidator('param', idParam), zValidator('json', voidInvoiceSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await voidInvoice(c.req.valid('param').id, b.reason, { reissue: b.reissue }, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
