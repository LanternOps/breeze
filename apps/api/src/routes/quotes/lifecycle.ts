import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { sendQuote } from '../../services/quoteLifecycle';
import { getQuote } from '../../services/quoteService';
import { writeQuoteImage, readQuoteImage, sniffImageMime, MAX_QUOTE_IMAGE_SIZE_BYTES } from '../../services/quoteImageStorage';
import { quoteActorFrom, handleServiceError } from './quotes';

export const quoteLifecycleRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action);
const idParam = z.object({ id: z.string().guid() });
const imageParam = z.object({ id: z.string().guid(), imageId: z.string().guid() });

// POST /:id/send — issue + email. Gated on the (previously dead) quotes:send permission.
quoteLifecycleRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await sendQuote(c.req.valid('param').id, quoteActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});

// POST /:id/images — multipart upload (magic-byte sniff + 5 MB cap). quotes:write.
quoteLifecycleRoutes.post('/:id/images',
  scopes, writePerm, zValidator('param', idParam),
  bodyLimit({ maxSize: MAX_QUOTE_IMAGE_SIZE_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'Image too large (max 5 MB)' }, 413) }),
  async (c) => {
    const id = c.req.valid('param').id;
    try {
      const { quote } = await getQuote(id, quoteActorFrom(c)); // org-access 404
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
