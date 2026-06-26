import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createCatalogItemSchema, updateCatalogItemSchema, listCatalogQuerySchema
} from '@breeze/shared';
import {
  createCatalogItem, updateCatalogItem, archiveCatalogItem, listCatalogItems, getCatalogItem,
  CatalogServiceError, type CatalogActor
} from '../../services/catalogService';
import {
  writeCatalogItemImage, readCatalogItemImage, deleteCatalogItemImage,
  fetchImageFromUrl, sniffImageMime, MAX_CATALOG_IMAGE_SIZE_BYTES,
} from '../../services/catalogImageStorage';

export const catalogItemRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const deletePerm = requirePermission(PERMISSIONS.CATALOG_DELETE.resource, PERMISSIONS.CATALOG_DELETE.action);
const idParam = z.object({ id: z.string().guid() });

export function catalogActorFrom(c: { get: (k: string) => unknown }): CatalogActor {
  const auth = c.get('auth') as AuthContext;
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds
  };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

catalogItemRoutes.get('/', scopes, readPerm, zValidator('query', listCatalogQuerySchema), async (c) => {
  try {
    const query = c.req.valid('query');
    const rows = await listCatalogItems(query, catalogActorFrom(c));
    // A full page implies there may be more rows; expose the last id as the cursor so
    // the documented `cursor` query param is usable. `data` shape is unchanged (web reads body.data).
    const nextCursor = rows.length === query.limit ? rows[rows.length - 1]!.id : null;
    return c.json({ data: rows, nextCursor });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.post('/', scopes, writePerm, zValidator('json', createCatalogItemSchema), async (c) => {
  try {
    const item = await createCatalogItem(c.req.valid('json'), catalogActorFrom(c));
    return c.json({ data: item });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    const data = await getCatalogItem(c.req.valid('param').id, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateCatalogItemSchema), async (c) => {
  try {
    const item = await updateCatalogItem(c.req.valid('param').id, c.req.valid('json'), catalogActorFrom(c));
    return c.json({ data: item });
  } catch (err) { return handleServiceError(c, err); }
});

catalogItemRoutes.post('/:id/archive', scopes, deletePerm, zValidator('param', idParam), async (c) => {
  try {
    const item = await archiveCatalogItem(c.req.valid('param').id, catalogActorFrom(c));
    return c.json({ data: item });
  } catch (err) { return handleServiceError(c, err); }
});

// POST /:id/image — multipart product-image upload (magic-byte sniff + 5 MB cap),
// one image per item (replaces). catalog:write. getCatalogItem 404s if the item
// is not this partner's, before any bytes are written.
catalogItemRoutes.post('/:id/image',
  scopes, writePerm, zValidator('param', idParam),
  bodyLimit({ maxSize: MAX_CATALOG_IMAGE_SIZE_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'Image too large (max 5 MB)' }, 413) }),
  async (c) => {
    const id = c.req.valid('param').id;
    const actor = catalogActorFrom(c);
    try {
      await getCatalogItem(id, actor); // 404 if not this partner's
      if (!actor.partnerId) return c.json({ error: 'Catalog is partner-scoped' }, 400);
      let body: Record<string, unknown>;
      try { body = await c.req.parseBody({ all: true }); } catch { return c.json({ error: 'Invalid multipart body' }, 400); }
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file field is required' }, 400);
      if (file.size === 0) return c.json({ error: 'file is empty' }, 400);
      if (file.size > MAX_CATALOG_IMAGE_SIZE_BYTES) return c.json({ error: 'Image too large (max 5 MB)' }, 413);
      const buffer = Buffer.from(await file.arrayBuffer());
      const mime = sniffImageMime(buffer);
      if (!mime) return c.json({ error: 'Unsupported image format. Allowed: PNG, JPEG, WebP.' }, 415);
      const written = await writeCatalogItemImage(id, actor.partnerId, mime, buffer);
      return c.json({ data: { imageId: written.id, mime, byteSize: written.byteSize } });
    } catch (err) { return handleServiceError(c, err); }
  });

// POST /:id/image/from-url — server-side download of a product image from a
// user-supplied URL (SSRF-guarded via safeFetch), then store it (replaces). The
// download/validation failure is mapped to a single generic 400 so internal
// fetch/SSRF errors don't leak to the client. catalog:write; ownership-checked.
catalogItemRoutes.post('/:id/image/from-url',
  scopes, writePerm, zValidator('param', idParam),
  zValidator('json', z.object({ url: z.string().url() })),
  async (c) => {
    const id = c.req.valid('param').id;
    const { url } = c.req.valid('json');
    const actor = catalogActorFrom(c);
    try {
      await getCatalogItem(id, actor); // 404 if not this partner's
      if (!actor.partnerId) return c.json({ error: 'Catalog is partner-scoped' }, 400);
      let mime: string, buffer: Buffer;
      try {
        ({ mime, buffer } = await fetchImageFromUrl(url));
      } catch {
        return c.json({ error: 'Could not download a valid image from that URL.' }, 400);
      }
      const written = await writeCatalogItemImage(id, actor.partnerId, mime, buffer);
      return c.json({ data: { imageId: written.id, mime, byteSize: written.byteSize } });
    } catch (err) { return handleServiceError(c, err); }
  });

// GET /:id/image — serve the product image. catalog:read. Ownership-checked first.
catalogItemRoutes.get('/:id/image', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    await getCatalogItem(id, catalogActorFrom(c)); // 404 if not owned
    const img = await readCatalogItemImage(id);
    if (!img) return c.json({ error: 'Image not found' }, 404);
    return new Response(new Uint8Array(img.data), {
      status: 200,
      headers: { 'Content-Type': img.mime, 'Content-Length': String(img.byteSize), 'Cache-Control': 'private, max-age=300' },
    });
  } catch (err) { return handleServiceError(c, err); }
});

// DELETE /:id/image — remove the product image. catalog:write.
catalogItemRoutes.delete('/:id/image', scopes, writePerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    await getCatalogItem(id, catalogActorFrom(c)); // 404 if not owned
    await deleteCatalogItemImage(id);
    return c.json({ data: { ok: true } });
  } catch (err) { return handleServiceError(c, err); }
});
