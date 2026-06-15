import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { orgPriceOverrideSchema } from '@breeze/shared';
import { setOrgPriceOverride, removeOrgPriceOverride, CatalogServiceError } from '../../services/catalogService';
import { catalogActorFrom } from './catalog';

export const catalogPricingRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const param = z.object({ id: z.string().uuid(), orgId: z.string().uuid() });

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

catalogPricingRoutes.put('/:id/pricing/:orgId', scopes, writePerm, zValidator('param', param), zValidator('json', orgPriceOverrideSchema), async (c) => {
  const p = c.req.valid('param');
  try {
    const row = await setOrgPriceOverride(p.id, p.orgId, c.req.valid('json'), catalogActorFrom(c));
    return c.json({ data: row });
  } catch (err) { return handleServiceError(c, err); }
});

catalogPricingRoutes.delete('/:id/pricing/:orgId', scopes, writePerm, zValidator('param', param), async (c) => {
  const p = c.req.valid('param');
  try {
    const row = await removeOrgPriceOverride(p.id, p.orgId, catalogActorFrom(c));
    return c.json({ data: row });
  } catch (err) { return handleServiceError(c, err); }
});
