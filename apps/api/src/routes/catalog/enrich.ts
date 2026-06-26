import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { enrichRequestSchema } from '@breeze/shared';
import { enrichCatalogItem, EnrichmentError } from '../../services/catalogEnrichmentService';

export const catalogEnrichRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);

catalogEnrichRoutes.post('/enrich', scopes, writePerm, zValidator('json', enrichRequestSchema), async (c) => {
  const { query, hint } = c.req.valid('json');
  const auth = c.get('auth') as AuthContext;
  // org-scope tokens carry orgId; partner-scope falls back to the first accessible
  // org as a best-effort billing target. When null (system scope), the service
  // skips budget/rate checks and logs a warning.
  const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  try {
    const data = await enrichCatalogItem(query, hint, { userId: auth.user.id, orgId });
    return c.json({ data });
  } catch (err) {
    if (err instanceof EnrichmentError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});
