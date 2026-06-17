import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { setBundleComponentsSchema } from '@breeze/shared';
import { setBundleComponents, computeBundleEconomics, CatalogServiceError } from '../../services/catalogService';
import { catalogActorFrom } from './catalog';

export const catalogBundleRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const econQuery = z.object({ orgId: z.string().guid().optional() });

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

catalogBundleRoutes.put('/:id/components', scopes, writePerm, zValidator('param', idParam), zValidator('json', setBundleComponentsSchema), async (c) => {
  try {
    const data = await setBundleComponents(c.req.valid('param').id, c.req.valid('json').components, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});

catalogBundleRoutes.get('/:id/economics', scopes, readPerm, zValidator('param', idParam), zValidator('query', econQuery), async (c) => {
  try {
    const data = await computeBundleEconomics(c.req.valid('param').id, c.req.valid('query').orgId ?? null, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});
