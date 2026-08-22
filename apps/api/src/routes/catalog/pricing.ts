import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { currencyCodeSchema, orgPriceOverrideSchema, setItemPriceSchema } from '@breeze/shared';
import {
  setOrgPriceOverride,
  removeOrgPriceOverride,
  setItemPrice,
  removeItemPrice,
  listItemPrices,
  resolvePrice,
  CatalogServiceError,
} from '../../services/catalogService';
import { catalogActorFrom } from './catalog';

export const catalogPricingRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const priceParam = z.object({ id: z.string().guid(), currencyCode: currencyCodeSchema });
const param = z.object({ id: z.string().guid(), orgId: z.string().guid() });
const resolveQuery = z.object({ currencyCode: currencyCodeSchema, orgId: z.string().guid().optional() });

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

/**
 * The server-side resolution (spec §6: org override in `currencyCode` → price-
 * book row → typed 409 gap) exposed read-only so document editors gate and
 * preview on the SAME answer the add path will use — never re-derived from
 * `item.prices`, which cannot see org overrides (post-merge review #6).
 */
catalogPricingRoutes.get('/:id/resolve', scopes, readPerm, zValidator('param', idParam), zValidator('query', resolveQuery), async (c) => {
  try {
    const q = c.req.valid('query');
    const data = await resolvePrice(c.req.valid('param').id, q.currencyCode, q.orgId ?? null, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});

catalogPricingRoutes.get('/:id/prices', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    const rows = await listItemPrices(c.req.valid('param').id, catalogActorFrom(c));
    return c.json({ data: rows });
  } catch (err) { return handleServiceError(c, err); }
});

catalogPricingRoutes.put(
  '/:id/prices/:currencyCode',
  scopes,
  writePerm,
  zValidator('param', priceParam),
  zValidator('json', setItemPriceSchema),
  async (c) => {
    const p = c.req.valid('param');
    try {
      const row = await setItemPrice(p.id, p.currencyCode, c.req.valid('json'), catalogActorFrom(c));
      return c.json({ data: row });
    } catch (err) { return handleServiceError(c, err); }
  },
);

catalogPricingRoutes.delete('/:id/prices/:currencyCode', scopes, writePerm, zValidator('param', priceParam), async (c) => {
  const p = c.req.valid('param');
  try {
    await removeItemPrice(p.id, p.currencyCode, catalogActorFrom(c));
    return c.json({ data: { ok: true } });
  } catch (err) { return handleServiceError(c, err); }
});
