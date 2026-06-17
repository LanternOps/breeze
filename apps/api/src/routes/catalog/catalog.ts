import { Hono } from 'hono';
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
