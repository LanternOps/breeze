import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { sendComposerSchema, parseComposerBody } from '../../lib/sendComposer';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { voidInvoiceSchema } from '@breeze/shared';
import { issueInvoice, voidInvoice, requireOrgAccess, requireSiteAccess } from '../../services/invoiceService';
import { getOrMintInvoiceLink, resetInvoiceLink, buildPublicInvoiceUrl } from '../../services/invoiceLinkToken';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { db } from '../../db';
import { invoices, invoiceDocuments } from '../../db/schema';
import { enqueueInvoicePdfRender } from '../../jobs/invoiceWorker';
import { eq } from 'drizzle-orm';
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

/** Load an invoice for the link-dispensing routes: RLS scopes the read (request
 *  context), the explicit org/site guards are defense-in-depth, and a DRAFT is
 *  refused — nothing has been issued, so there is nothing to link. Void is
 *  allowed: its public page renders the calm no-amounts state, and "copy the
 *  link so the customer can see it's cancelled" is a legitimate ask. */
async function loadLinkableInvoice(id: string, actor: ReturnType<typeof invoiceActorFrom>) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, inv.orgId);
  requireSiteAccess(actor, inv.siteId);
  if (inv.status === 'draft') {
    throw new InvoiceServiceError('This invoice has not been issued yet — issue it to create a link', 409, 'INVALID_STATE');
  }
  return inv;
}

// GET /:id/public-link — hand back the invoice's durable view-and-pay link for
// pasting into a chat/SMS by hand. This dispenses a live credential, hence the
// invoices:send permission (not :read) and the audit record on every call —
// mirrors quotes' GET /:id/share-link.
invoiceLifecycleRoutes.get('/:id/public-link', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const inv = await loadLinkableInvoice(id, invoiceActorFrom(c));
    const link = await getOrMintInvoiceLink({
      id: inv.id, dueDate: inv.dueDate,
      publicLinkTokenHash: inv.publicLinkTokenHash,
      publicLinkTokenCt: inv.publicLinkTokenCt,
      publicLinkExpiresAt: inv.publicLinkExpiresAt,
    });
    writeRouteAudit(c, {
      orgId: inv.orgId,
      action: 'invoice.public_link_viewed',
      resourceType: 'invoice',
      resourceId: id,
      result: 'success',
      // origin distinguishes "the customer's existing link is unchanged"
      // ('reproduced') from "prior links are now dead" ('minted_*').
      details: { linkOrigin: link.origin },
    });
    return c.json({ data: { url: buildPublicInvoiceUrl(link.token), expiresAt: link.expiresAt, origin: link.origin } });
  } catch (err) { return handleServiceError(c, err); }
});

// POST /:id/reset-link — revoke every issued link and mint a fresh one. The
// next send/copy dispenses the new url; anyone holding an old one gets the
// generic invalid-link page.
invoiceLifecycleRoutes.post('/:id/reset-link', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const inv = await loadLinkableInvoice(id, invoiceActorFrom(c));
    const link = await resetInvoiceLink({ id: inv.id, dueDate: inv.dueDate });
    // The stored PDF prints the OLD link ("Pay online: …"), and both re-send
    // and download reuse the artifact without re-rendering — purge it so the
    // next touch re-renders with the fresh url, and kick the async render so
    // the artifact is usually back before anyone needs it.
    await db.delete(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, inv.id));
    await db.update(invoices).set({ pdfDocumentRef: null, pdfSha256: null, updatedAt: new Date() }).where(eq(invoices.id, inv.id));
    try { await enqueueInvoicePdfRender(inv.id); } catch (err) {
      console.error('[invoices] PDF re-render enqueue failed after link reset (next send/download renders inline)', { invoiceId: inv.id, err });
    }
    writeRouteAudit(c, {
      orgId: inv.orgId,
      action: 'invoice.public_link_reset',
      resourceType: 'invoice',
      resourceId: id,
      result: 'success',
    });
    return c.json({ data: { url: buildPublicInvoiceUrl(link.token), expiresAt: link.expiresAt } });
  } catch (err) { return handleServiceError(c, err); }
});
