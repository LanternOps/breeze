import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { acceptQuoteOnBehalfSchema } from '@breeze/shared';
import { sendComposerSchema as sendBodySchema, parseComposerBody } from '../../lib/sendComposer';
import { requireScope, requirePermission, withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { sendQuote, resendQuote, getQuoteShareLink } from '../../services/quoteLifecycle';
import { writeRouteAudit } from '../../services/auditEvents';
import { supersededAuditEvent } from '../../services/quoteSupersedeAudit';
import { scheduleQuoteSend, cancelQuoteSend } from '../../jobs/quoteSendQueue';
import { getQuote } from '../../services/quoteService';
import { writeQuoteImage, readQuoteImage, sniffImageMime, MAX_QUOTE_IMAGE_SIZE_BYTES, fetchRemoteImage, RemoteImageError, QUOTE_IMAGE_WEBP_REJECTED_MESSAGE, type RemoteImageFailureReason } from '../../services/quoteImageStorage';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { acceptQuote, emitAcceptInvoiceIssued, resolveAcceptInvoiceUrl, autoEmailAcceptedInvoice } from '../../services/quoteAcceptService';
import { notifyQuoteOutcome } from '../../services/quoteOutcomeNotify';
import { acceptedOnBehalfAuditEvent } from '../../services/quoteAcceptOnBehalfAudit';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { quoteActorFrom, handleServiceError } from './quotes';

export const quoteLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action);
const acceptPerm = requirePermission(PERMISSIONS.QUOTES_ACCEPT.resource, PERMISSIONS.QUOTES_ACCEPT.action);
const idParam = z.object({ id: z.string().guid() });
const imageParam = z.object({ id: z.string().guid(), imageId: z.string().guid() });
const contractFileParam = z.object({ id: z.string().guid(), blockId: z.string().guid() });

// Accepts only http(s) URLs; the fetch layer enforces size/mime.
const imageFromUrlSchema = z.object({
  url: z.string().refine((s) => {
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch { return false; }
  }, 'url must be an http(s) URL'),
});

function remoteImageStatus(reason: RemoteImageFailureReason): 413 | 415 | 502 | 504 {
  switch (reason) {
    case 'too_large': return 413;
    case 'not_image': return 415;
    case 'timeout': return 504;
    case 'unreachable': return 502;
  }
}

// POST /:id/send — issue + email. Gated on the (previously dead) quotes:send permission.
//
// #3905 — issue and email are two transactions, not one. This route is
// registered in SELF_MANAGED_DB_CONTEXT_ROUTES, so the auth middleware opens NO
// ambient request transaction: `withAuthDbAccessContext` opens a short one that
// COMMITS when sendQuote resolves, and only then does the deferred render the
// PDF and run the mail round-trip. Before the split, both ran inside the
// request transaction while it held the quote's — and, on a revision, its
// PARENT's — FOR UPDATE lock, so a stalled mail server blocked the customer's
// own accept on the original quote and pinned a pooled connection for as long
// as it liked. Do NOT collapse these two awaits back into one context: a
// `runOutsideDbContext` around the deferred would NOT help, because it only
// re-points the ALS `db` proxy and leaves the outer transaction open.
quoteLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const body = await parseComposerBody(c, sendBodySchema);
  if (!body.ok) return c.json({ error: body.error }, 400);
  const emailOpts = body.data;
  try {
    const id = c.req.valid('param').id;
    const auth = c.get('auth') as AuthContext;
    const sent = await withAuthDbAccessContext(auth, () => sendQuote(id, quoteActorFrom(c), {
      message: emailOpts.message || undefined,
      to: emailOpts.to,
      cc: emailOpts.cc,
      subject: emailOpts.subject || undefined,
      includePdf: emailOpts.includePdf,
    }));
    // Post-commit. Never rejects; it swallows every delivery failure into
    // `emailReason` and persists it to send_email_reason itself (#3502).
    const delivery = await sent.deliverEmail();
    // Retiring a quote the customer could previously accept is a separate,
    // independently-auditable act from sending the revision — record it against
    // the PARENT, which is the row whose status actually changed.
    if (sent.superseded) {
      // writeRouteAudit (not writeAuditEvent) so the acting tech is attributed;
      // the payload itself is shared with the worker/bulk/AI paths.
      writeRouteAudit(c, supersededAuditEvent({
        childQuoteId: id,
        orgId: sent.quote.orgId,
        parentQuoteId: sent.superseded.parentQuoteId,
        previousStatus: sent.superseded.previousStatus,
        revisionNumber: sent.quote.revisionNumber,
        emailed: delivery.emailed,
      }));
    }
    // Response shape is otherwise unchanged from before the deferred split —
    // the web detail page reads `emailed`/`emailReason` off this payload.
    // `deviceSetDrift` is computed synchronously (before the email is
    // deferred), so it rides on `sent`, not the post-commit `delivery`.
    return c.json({ data: {
      quote: delivery.quote,
      emailed: delivery.emailed,
      emailReason: delivery.emailReason,
      acceptUrl: sent.acceptUrl,
      superseded: sent.superseded,
      deviceSetDrift: sent.deviceSetDrift,
    } });
  } catch (err) { return handleServiceError(c, err); }
});

// POST /:id/accept-on-behalf — the tech closed the deal on the phone, by email
// or on a signed PO, and records the customer's acceptance in-app. Runs the
// EXACT conversion pipeline a customer click runs (invoice numbered + issued at
// the quote's frozen totals and tax, recurring lines drafted as contracts, Pax8
// staged); the only differences are the eligible statuses, the inline draft
// claim, and the provenance stored on the acceptance row.
//
// Gated on quotes:accept, NOT quotes:send: this is the money-committing act,
// and an MSP may want it narrower than sending. Org access is enforced by the
// auth scope plus the org-scoped getQuote below, BEFORE the handler enters
// system context.
//
// Registered in SELF_MANAGED_DB_CONTEXT_ROUTES, so the auth middleware opens no
// ambient transaction: the lookup runs in a short withAuthDbAccessContext and
// the accept in its own system context. partner_invoice_sequences is
// partner-axis, invisible to an org-scoped context (#1375), and the whole
// accept must be ONE transaction — the same reason routes/portal/quotes.ts
// wraps its accept this way.
quoteLifecycleRoutes.post('/:id/accept-on-behalf',
  scopes, acceptPerm,
  zValidator('param', idParam), zValidator('json', acceptQuoteOnBehalfSchema),
  async (c) => {
    const id = c.req.valid('param').id;
    const body = c.req.valid('json');
    const auth = c.get('auth') as AuthContext;
    const actorUserId = auth.user?.id ?? null;
    try {
      // Org-access 404 + the pre-accept status, in the request's own scope.
      // Read the status HERE: acceptQuote mutates the quote row it returns, so
      // `res.quote.status` is already 'converted' by the time we audit.
      const { quote, blocks } = await withAuthDbAccessContext(auth, () => getQuote(id, quoteActorFrom(c)));
      const wasDraft = quote.status === 'draft';
      // Contract-block render data is pre-fetched OUTSIDE the accept
      // transaction: loadContractBlockRenderData resolves pinned template
      // versions under a SYSTEM context (the dual-axis template rows are
      // invisible to an org scope), and acceptQuote hard-fails if a contract
      // block is missing from the set.
      const contractRenderData = await loadContractBlockRenderData(blocks, { includeFileData: true });

      const res = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptQuote({
        quoteId: id,
        signerName: body.signerName,
        signerEmail: body.signerEmail ?? null,
        // Never the raw header: getTrustedClientIpOrUndefined applies the
        // trusted-proxy policy. Clamped to the column width.
        ipAddress: getTrustedClientIpOrUndefined(c)?.slice(0, 64) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        actorUserId,
        origin: 'on_behalf',
        method: body.method,
        reference: body.reference,
        contractRenderData,
      })));

      // #6638: audit FIRST, immediately after the accept transaction commits —
      // this feature's whole point is the audit record, so it must land even if
      // a later post-commit side effect throws. Both helpers below are
      // documented as non-throwing today (internal try/catch, return null on
      // error), but a future regression in either must not silently drop the
      // acceptance's own audit trail.
      writeRouteAudit(c, acceptedOnBehalfAuditEvent({
        quoteId: id,
        orgId: res.quote.orgId,
        method: body.method,
        reference: body.reference,
        signerName: body.signerName,
        signerEmail: body.signerEmail ?? null,
        invoiceId: res.invoiceId,
        // The number the accept ALLOCATED, not res.quote.quoteNumber — that is
        // the quote's own number and would name the wrong document.
        invoiceNumber: res.invoiceNumber,
        contractIds: res.contractIds,
        wasDraft,
      }));
      // Retiring a revision's parent is a separate, independently-auditable act
      // — the same rule /send follows.
      if (res.superseded) {
        writeRouteAudit(c, supersededAuditEvent({
          childQuoteId: id,
          orgId: res.quote.orgId,
          parentQuoteId: res.superseded.parentQuoteId,
          previousStatus: res.superseded.previousStatus,
          revisionNumber: res.quote.revisionNumber,
          emailed: false,
        }));
      }

      // Post-commit, outside the DB context — identical to the portal accept.
      await emitAcceptInvoiceIssued(res, actorUserId);
      const payUrl = await resolveAcceptInvoiceUrl(res);
      // Both end in SMTP round trips and must never delay the response; both
      // swallow their own errors. source 'msp' emits the bus event and sends NO
      // creator email — the tech who did this already knows.
      void autoEmailAcceptedInvoice(res);
      void notifyQuoteOutcome({
        quoteId: id, outcome: 'accepted', source: 'msp',
        signerName: body.signerName, origin: 'on_behalf', actorUserId,
      });

      return c.json({ data: {
        quote: res.quote,
        invoiceId: res.invoiceId,
        invoiceIssued: res.invoiceIssued,
        // The number the accept ALLOCATED — same value the audit event carries,
        // and the only number the UI may put in "Invoice … issued". Without it
        // the web toast reached for res.quote.quoteNumber and named the quote's
        // own number, i.e. a document that does not exist. null when no number
        // was allocated (a recurring-only quote leaves the invoice in draft),
        // which the caller must word differently rather than print as blank.
        invoiceNumber: res.invoiceNumber,
        contractIds: res.contractIds,
        payUrl,
      } });
    } catch (err) { return handleServiceError(c, err); }
  });

// POST /:id/schedule-send — the undo-send window. Validates like a send-open
// (draft + at least one customer-visible line) then schedules the REAL send as
// a delayed job; the quote stays a draft with the window stamped so the UI can
// offer Undo. Deep send-time gates (contract variables etc.) run when the job
// fires — a fire-time rejection leaves the quote a draft with the schedule
// cleared, never a half-sent state. Same quotes:send permission as /send.
const scheduleSendSchema = sendBodySchema.extend({
  delaySeconds: z.number().int().min(5).max(300).optional(),
});
quoteLifecycleRoutes.post('/:id/schedule-send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  const parsed = await parseComposerBody(c, scheduleSendSchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.data;
  try {
    const actor = quoteActorFrom(c);
    const { quote, lines } = await getQuote(id, actor); // org-access 404
    if (quote.status !== 'draft') return c.json({ error: 'Only a draft can be sent', code: 'INVALID_STATE' }, 409);
    if (!lines.some((l) => l.customerVisible)) return c.json({ error: 'Add at least one item before sending', code: 'QUOTE_EMPTY' }, 422);
    const { sendScheduledAt } = await scheduleQuoteSend(id, actor, {
      message: body.message || undefined,
      to: body.to,
      cc: body.cc,
      subject: body.subject || undefined,
      includePdf: body.includePdf,
    }, (body.delaySeconds ?? 30) * 1000);
    return c.json({ data: { sendScheduledAt: sendScheduledAt.toISOString() } });
  } catch (err) { return handleServiceError(c, err); }
});

// POST /:id/resend — re-email an already-sent quote using its EXISTING accept
// link. Not a second send: status, sentAt, quote number and the send-time
// bill-to/seller snapshots are all left pinned to the original issue (see
// resendQuote). Same quotes:send permission as /send.
quoteLifecycleRoutes.post('/:id/resend', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  const parsed = await parseComposerBody(c, sendBodySchema);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    // Same two-transaction shape as /send (#3905) — this route is likewise
    // registered in SELF_MANAGED_DB_CONTEXT_ROUTES. resendQuote takes a
    // FOR UPDATE lock on the quote to serialize against a concurrent supersede;
    // that lock is released by the commit below, before any mail I/O.
    const auth = c.get('auth') as AuthContext;
    const resent = await withAuthDbAccessContext(auth, () => resendQuote(id, quoteActorFrom(c), {
      message: parsed.data.message || undefined,
      to: parsed.data.to,
      cc: parsed.data.cc,
      subject: parsed.data.subject || undefined,
      includePdf: parsed.data.includePdf,
    }));
    const delivery = await resent.deliverEmail();
    writeRouteAudit(c, {
      orgId: delivery.quote.orgId,
      action: 'quote.resend',
      resourceType: 'quote',
      resourceId: id,
      result: delivery.emailed ? 'success' : 'failure',
      // `origin` is the notable field: it distinguishes "the customer's
      // original link still works alongside the new one" from "their original
      // link is now dead", which the bare boolean cannot.
      details: { emailed: delivery.emailed, emailReason: delivery.emailReason, reissued: resent.reissued, linkOrigin: resent.origin },
    });
    return c.json({ data: {
      quote: delivery.quote,
      emailed: delivery.emailed,
      emailReason: delivery.emailReason,
      acceptUrl: resent.acceptUrl,
      origin: resent.origin,
      reissued: resent.reissued,
    } });
  } catch (err) { return handleServiceError(c, err); }
});

// GET /:id/share-link — hand back the quote's accept link without emailing
// anything, for pasting into a chat/SMS by hand. This dispenses a live accept
// credential, hence the quotes:send permission (not quotes:read) and the audit
// record on every successful call.
quoteLifecycleRoutes.get('/:id/share-link', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const result = await getQuoteShareLink(id, quoteActorFrom(c));
    writeRouteAudit(c, {
      orgId: result.orgId,
      action: 'quote.share_link_viewed',
      resourceType: 'quote',
      resourceId: id,
      result: 'success',
      details: { reissued: result.reissued, linkOrigin: result.origin },
    });
    return c.json({ data: result });
  } catch (err) { return handleServiceError(c, err); }
});

// DELETE /:id/schedule-send — Undo. Clears the schedule; `canceled: false`
// means the window had already elapsed (the send fired or is firing).
quoteLifecycleRoutes.delete('/:id/schedule-send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    await getQuote(id, quoteActorFrom(c)); // org-access 404
    const canceled = await cancelQuoteSend(id);
    return c.json({ data: { canceled } });
  } catch (err) { return handleServiceError(c, err); }
});

// POST /:id/images — multipart file upload OR JSON {url} to copy a remote image
// (magic-byte sniff + 5 MB cap either way). quotes:write.
quoteLifecycleRoutes.post('/:id/images',
  scopes, writePerm, zValidator('param', idParam),
  bodyLimit({ maxSize: MAX_QUOTE_IMAGE_SIZE_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'Image too large (max 5 MB)' }, 413) }),
  async (c) => {
    const id = c.req.valid('param').id;
    try {
      const { quote } = await getQuote(id, quoteActorFrom(c)); // org-access 404

      // JSON body → copy the image from a URL (server-side, not a hotlink).
      // Multipart (below) is unchanged.
      if ((c.req.header('content-type') ?? '').includes('application/json')) {
        let json: unknown;
        try { json = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
        const parsed = imageFromUrlSchema.safeParse(json);
        if (!parsed.success) return c.json({ error: 'url must be an http(s) URL' }, 400);
        let fetched: { mime: string; buffer: Buffer };
        try {
          fetched = await fetchRemoteImage(parsed.data.url);
        } catch (err) {
          if (err instanceof RemoteImageError) return c.json({ error: err.message }, remoteImageStatus(err.reason));
          throw err;
        }
        const written = await writeQuoteImage(id, quote.orgId, fetched.mime, fetched.buffer);
        return c.json({ data: { imageId: written.id, mime: fetched.mime, byteSize: written.byteSize } });
      }

      let body: Record<string, unknown>;
      try { body = await c.req.parseBody({ all: true }); } catch { return c.json({ error: 'Invalid multipart body' }, 400); }
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400);
      if (file.size === 0) return c.json({ error: 'file is empty' }, 400);
      if (file.size > MAX_QUOTE_IMAGE_SIZE_BYTES) return c.json({ error: 'Image too large (max 5 MB)' }, 413);
      const buffer = Buffer.from(await file.arrayBuffer());
      const mime = sniffImageMime(buffer);
      if (!mime) return c.json({ error: 'Unsupported image format. Allowed: PNG, JPEG.' }, 415);
      if (mime === 'image/webp') return c.json({ error: QUOTE_IMAGE_WEBP_REJECTED_MESSAGE }, 415);
      const written = await writeQuoteImage(id, quote.orgId, mime, buffer);
      return c.json({ data: { imageId: written.id, mime, byteSize: written.byteSize } });
    } catch (err) { return handleServiceError(c, err); }
  });

// GET /:id/images/:imageId — serve for the editor preview. quotes:read.
quoteLifecycleRoutes.get('/:id/images/:imageId', scopes, readPerm, zValidator('param', imageParam), async (c) => {
  const { id, imageId } = c.req.valid('param');
  try {
    await getQuote(id, quoteActorFrom(c)); // org-access 404 before serving bytes
    const img = await readQuoteImage(imageId, id);
    if (!img) return c.json({ error: 'Image not found' }, 404);
    return new Response(new Uint8Array(img.data), { status: 200, headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return handleServiceError(c, err); }
});

// GET /:id/contract-file/:blockId — uploaded contract PDF bytes for the editor
// preview, mirroring /:id/images/:imageId. getQuote's org-access check + finding
// the block among ITS OWN blocks (not a bare id lookup) closes the cross-quote
// blockId case the same way the image route's quote_id match does.
quoteLifecycleRoutes.get('/:id/contract-file/:blockId', scopes, readPerm, zValidator('param', contractFileParam), async (c) => {
  const { id, blockId } = c.req.valid('param');
  try {
    const { blocks } = await getQuote(id, quoteActorFrom(c)); // org-access 404
    const block = blocks.find((b) => b.id === blockId && b.blockType === 'contract');
    if (!block) return c.json({ error: 'Contract file not found' }, 404);
    const [renderData] = await loadContractBlockRenderData([block], { includeFileData: true });
    if (!renderData || renderData.sourceType !== 'uploaded' || !renderData.fileData) {
      return c.json({ error: 'Contract file not found' }, 404);
    }
    return new Response(new Uint8Array(renderData.fileData), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(renderData.fileData.length), 'Cache-Control': 'private, max-age=300' } });
  } catch (err) { return handleServiceError(c, err); }
});
