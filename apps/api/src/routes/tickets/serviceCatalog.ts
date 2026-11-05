import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ERROR_CODES,
  createServiceCatalogItemSchema,
  listServiceCatalogItemsQuerySchema,
  updateServiceCatalogItemSchema,
  updateServiceCatalogSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { hasPermission, PERMISSIONS } from '../../services/permissions';
import {
  archiveItem,
  createItem,
  getCatalog,
  getItem,
  getOrCreateCatalog,
  listItems,
  ServiceCatalogError,
  updateCatalog,
  updateItem,
} from '../../services/serviceCatalogService';
import { pgErrorCode } from '../../utils/pgErrors';

/**
 * Service catalog management API (#8325, wave A1). One catalog per partner;
 * items are partner-wide. Spec: docs/superpowers/specs/ticketing/2026-10-10-service-catalog-design.md §5, §8.
 *
 * Root-mounted router (absolute paths): authMiddleware must lead EACH route's
 * middleware chain, never a router-level .use('*') (the #1383 footgun, see
 * forms.ts). Partner-only: org tokens never reach a handler.
 *
 * `showInPortal` is stored and returned but has no consumer yet; the customer
 * portal catalog (wave D) will read it.
 */
export const serviceCatalogRoutes = new Hono();

const requireTicketRead = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const requireTicketWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
const scopes = requireScope('partner', 'system');
const idParamSchema = z.object({ id: z.string().guid() });

type Denied = { status: 403; body: { error: string; code: string } };

/** Resolve the caller's partner or a 403 body. System tokens without a partner cannot own a catalog. */
function resolvePartner(auth: { partnerId: string | null }): { partnerId: string } | Denied {
  if (!auth.partnerId) {
    return { status: 403, body: { error: 'Service catalog requires a partner context', code: ERROR_CODES.ACCESS_DENIED } };
  }
  return { partnerId: auth.partnerId };
}

/** Resolve the partner for a write: also applies the partner-wide gate. */
function resolveWritePartner(auth: Parameters<typeof canManagePartnerWidePolicies>[0] & { partnerId: string | null }): { partnerId: string } | Denied {
  const p = resolvePartner(auth);
  if ('status' in p) return p;
  if (!canManagePartnerWidePolicies(auth)) {
    return { status: 403, body: { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: ERROR_CODES.ACCESS_DENIED } };
  }
  return p;
}

function validationFailed(c: Context, message: string, field?: string) {
  return c.json({ error: message, code: ERROR_CODES.VALIDATION_FAILED, ...(field ? { details: { fieldErrors: { [field]: [message] } } } : {}) }, 400);
}

/** Domain/constraint failures become 400; anything else is rethrown (500). */
function handleWriteError(c: Context, err: unknown): Response {
  if (err instanceof ServiceCatalogError) return validationFailed(c, err.message, err.field);
  const code = pgErrorCode(err);
  if (code === '23503' || code === '23514') return validationFailed(c, 'Request violates a service catalog constraint');
  throw err;
}

const itemNotFound = (c: Context) => c.json({ error: 'Service catalog item not found', code: ERROR_CODES.NOT_FOUND }, 404);

serviceCatalogRoutes.get('/service-catalog', authMiddleware, scopes, requireTicketRead, async (c) => {
  const auth = c.get('auth');
  const p = resolvePartner(auth);
  if ('status' in p) return c.json(p.body, p.status);

  // D1: only a caller that could write the catalog may create it on read. A
  // read-only caller never causes a write; it sees null until a writer visits.
  const perms = c.get('permissions') as Parameters<typeof hasPermission>[0] | undefined;
  const canWrite =
    canManagePartnerWidePolicies(auth) &&
    !!perms &&
    hasPermission(perms, PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
  if (!canWrite) return c.json({ data: await getCatalog(p.partnerId) });

  try {
    const { catalog, created } = await getOrCreateCatalog(p.partnerId);
    if (created) {
      writeRouteAudit(c, {
        orgId: null,
        action: 'service_catalog.create',
        resourceType: 'service_catalog',
        resourceId: catalog.id,
        resourceName: catalog.name,
        details: { catalogId: catalog.id, partnerWide: true },
      });
    }
    return c.json({ data: catalog });
  } catch (err) {
    return handleWriteError(c, err);
  }
});

serviceCatalogRoutes.put(
  '/service-catalog',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('json', updateServiceCatalogSchema),
  async (c) => {
    const p = resolveWritePartner(c.get('auth'));
    if ('status' in p) return c.json(p.body, p.status);
    const payload = c.req.valid('json');
    try {
      const row = await updateCatalog(p.partnerId, payload);
      writeRouteAudit(c, {
        orgId: null,
        action: 'service_catalog.update',
        resourceType: 'service_catalog',
        resourceId: row.id,
        resourceName: row.name,
        details: { catalogId: row.id, changedFields: Object.keys(payload), partnerWide: true },
      });
      return c.json({ data: row });
    } catch (err) {
      return handleWriteError(c, err);
    }
  }
);

serviceCatalogRoutes.get(
  '/service-catalog/items',
  authMiddleware,
  scopes,
  requireTicketRead,
  zValidator('query', listServiceCatalogItemsQuerySchema),
  async (c) => {
    const p = resolvePartner(c.get('auth'));
    if ('status' in p) return c.json(p.body, p.status);
    const data = await listItems(p.partnerId, c.req.valid('query'));
    return c.json({ data });
  }
);

serviceCatalogRoutes.post(
  '/service-catalog/items',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('json', createServiceCatalogItemSchema),
  async (c) => {
    const p = resolveWritePartner(c.get('auth'));
    if ('status' in p) return c.json(p.body, p.status);
    try {
      const row = await createItem(p.partnerId, c.req.valid('json'));
      writeRouteAudit(c, {
        orgId: null,
        action: 'service_catalog_item.create',
        resourceType: 'service_catalog_item',
        resourceId: row.id,
        resourceName: row.name,
        details: { itemId: row.id, catalogId: row.catalogId, name: row.name, partnerWide: true },
      });
      return c.json({ data: row }, 201);
    } catch (err) {
      return handleWriteError(c, err);
    }
  }
);

serviceCatalogRoutes.get(
  '/service-catalog/items/:id',
  authMiddleware,
  scopes,
  requireTicketRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const p = resolvePartner(c.get('auth'));
    if ('status' in p) return c.json(p.body, p.status);
    const row = await getItem(p.partnerId, c.req.valid('param').id);
    if (!row) return itemNotFound(c);
    return c.json({ data: row });
  }
);

serviceCatalogRoutes.patch(
  '/service-catalog/items/:id',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', updateServiceCatalogItemSchema),
  async (c) => {
    const p = resolveWritePartner(c.get('auth'));
    if ('status' in p) return c.json(p.body, p.status);
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');
    try {
      const result = await updateItem(p.partnerId, id, payload);
      if (!result) return itemNotFound(c);
      const { before, after } = result;
      const action =
        before.isActive === after.isActive
          ? 'service_catalog_item.update'
          : after.isActive
            ? 'service_catalog_item.restore'
            : 'service_catalog_item.archive';
      writeRouteAudit(c, {
        orgId: null,
        action,
        resourceType: 'service_catalog_item',
        resourceId: after.id,
        resourceName: after.name,
        details: { itemId: after.id, name: after.name, changedFields: Object.keys(payload), partnerWide: true },
      });
      return c.json({ data: after });
    } catch (err) {
      return handleWriteError(c, err);
    }
  }
);

// DELETE never removes the row: tickets/quotes will reference items, so it
// archives (is_active=false). Idempotent; a repeat call is a 200 with no audit.
serviceCatalogRoutes.delete(
  '/service-catalog/items/:id',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const p = resolveWritePartner(c.get('auth'));
    if ('status' in p) return c.json(p.body, p.status);
    const result = await archiveItem(p.partnerId, c.req.valid('param').id);
    if (!result) return itemNotFound(c);
    if (result.changed) {
      writeRouteAudit(c, {
        orgId: null,
        action: 'service_catalog_item.archive',
        resourceType: 'service_catalog_item',
        resourceId: result.item.id,
        resourceName: result.item.name,
        details: { itemId: result.item.id, name: result.item.name, partnerWide: true },
      });
    }
    return c.json({ data: result.item });
  }
);
