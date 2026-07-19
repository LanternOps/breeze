import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { sendQuote } from '../../services/quoteLifecycle';
import { scheduleQuoteSend, cancelQuoteSend } from '../../jobs/quoteSendQueue';
import { getQuote } from '../../services/quoteService';
import { writeQuoteImage, readQuoteImage, sniffImageMime, MAX_QUOTE_IMAGE_SIZE_BYTES, fetchRemoteImage, RemoteImageError, type RemoteImageFailureReason } from '../../services/quoteImageStorage';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';
import { quoteActorFrom, handleServiceError } from './quotes';

export const quoteLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action);
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

// Composer options for the customer email. `.strict()` so a mis-keyed field
// (e.g. {"mesage":"hi"}) is a 400, not a silently dropped note.
const sendEmailField = z.string().trim().email().max(255);
const sendBodySchema = z.object({
  message: z.string().trim().max(2000).optional(),
  // Composer fields (all optional — an empty body reproduces the classic send):
  // explicit recipients override the org billing-contact fallback.
  to: z.array(sendEmailField).min(1).max(10).optional(),
  cc: z.array(sendEmailField).max(10).optional(),
  subject: z.string().trim().max(200).optional(),
  includePdf: z.boolean().optional(),
}).strict();

// POST /:id/send — issue + email. Gated on the (previously dead) quotes:send permission.
quoteLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  let emailOpts: z.infer<typeof sendBodySchema> = {};
  // Distinguish an ABSENT body (most callers — bulk-send/MCP/tests POST nothing,
  // yet fetchWithAuth still stamps a JSON content-type) from a PRESENT-but-broken
  // one. An empty body degrades to "no message"; a non-empty body that fails to
  // parse/validate is rejected 400 rather than silently swallowing a note the
  // sender intended (mirrors the image-from-URL route below).
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    // A body-READ failure (stream aborted mid-request) is not the same as an
    // intentionally absent body: proceeding would silently drop the composer's
    // explicit recipients and fall back to the org billing contact. Reject it.
    const raw = await c.req.text().catch(() => null);
    if (raw === null) return c.json({ error: 'Could not read request body' }, 400);
    if (raw.trim()) {
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
      const parsed = sendBodySchema.safeParse(json);
      if (!parsed.success) return c.json({ error: 'Invalid send options' }, 400);
      emailOpts = parsed.data;
    }
  }
  try {
    return c.json({ data: await sendQuote(c.req.valid('param').id, quoteActorFrom(c), {
      message: emailOpts.message || undefined,
      to: emailOpts.to,
      cc: emailOpts.cc,
      subject: emailOpts.subject || undefined,
      includePdf: emailOpts.includePdf,
    }) });
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
  let body: z.infer<typeof scheduleSendSchema> = {};
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    // A body-READ failure (stream aborted mid-request) is not the same as an
    // intentionally absent body: proceeding would silently drop the composer's
    // explicit recipients and fall back to the org billing contact. Reject it.
    const raw = await c.req.text().catch(() => null);
    if (raw === null) return c.json({ error: 'Could not read request body' }, 400);
    if (raw.trim()) {
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
      const parsed = scheduleSendSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: 'Invalid send options' }, 400);
      body = parsed.data;
    }
  }
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
      if (!mime) return c.json({ error: 'Unsupported image format. Allowed: PNG, JPEG, WebP.' }, 415);
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
