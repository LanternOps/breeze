import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { currencyCodeSchema, setBundleComponentsSchema } from '@breeze/shared';
import { setBundleComponents, computeBundleEconomics, CatalogServiceError } from '../../services/catalogService';
import { db } from '../../db';
import { organizations, partners } from '../../db/schema';
import { catalogActorFrom } from './catalog';

export const catalogBundleRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CATALOG_READ.resource, PERMISSIONS.CATALOG_READ.action);
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const econQuery = z.object({ orgId: z.string().guid().optional(), currencyCode: currencyCodeSchema.optional() });

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof CatalogServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

// Default economics currency when the caller does not name one: the org's currency
// when an orgId is given (scoped to the actor's partner — RLS already hides other
// partners' orgs, this just makes the 404 structural), else the partner's. No 'USD'
// fallback anywhere: a missing owner row is a 404, never a silently-converted number.
async function defaultCurrencyFor(orgId: string | null, partnerId: string | null): Promise<string> {
  if (!partnerId) throw new CatalogServiceError('Catalog is partner-scoped; no partner in context', 400, 'PARTNER_UNRESOLVABLE');
  if (orgId) {
    const [row] = await db.select({ currencyCode: organizations.currencyCode }).from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId))).limit(1);
    if (!row) throw new CatalogServiceError('Organization not found', 404);
    return row.currencyCode;
  }

  const [row] = await db.select({ currencyCode: partners.currencyCode }).from(partners)
    .where(eq(partners.id, partnerId)).limit(1);
  if (!row) throw new CatalogServiceError('Partner not found', 404, 'PARTNER_UNRESOLVABLE');
  return row.currencyCode;
}

catalogBundleRoutes.put('/:id/components', scopes, writePerm, zValidator('param', idParam), zValidator('json', setBundleComponentsSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await setBundleComponents(c.req.valid('param').id, body.components, catalogActorFrom(c), body.allocationCurrency);
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});

catalogBundleRoutes.get('/:id/economics', scopes, readPerm, zValidator('param', idParam), zValidator('query', econQuery), async (c) => {
  try {
    const q = c.req.valid('query');
    const auth = c.get('auth') as AuthContext;
    const currency = q.currencyCode ?? await defaultCurrencyFor(q.orgId ?? null, auth.partnerId);
    const data = await computeBundleEconomics(c.req.valid('param').id, currency, q.orgId ?? null, catalogActorFrom(c));
    return c.json({ data });
  } catch (err) { return handleServiceError(c, err); }
});
