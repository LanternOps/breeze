import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { enrichRequestSchema, polishTextRequestSchema } from '@breeze/shared';
import { enrichCatalogItem, polishCatalogText, EnrichmentError } from '../../services/catalogEnrichmentService';

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

// "Polish with AI" — presentation-only clean-up of a name/description the user
// already has, shared by the catalog item, quote line, and invoice line editors.
// Gated on scope only (no CATALOG_WRITE): it persists nothing and returns a
// suggestion the user applies through their own permissioned save, so coupling it
// to one resource's write permission would needlessly lock out quote/invoice
// editors. AI spend is bounded by the org budget + per-user rate limit when an
// org resolves, and by a per-user rate limit when it doesn't (partner-level
// catalog) — see polishCatalogText, so a read-only caller can't run it unbounded.
catalogEnrichRoutes.post('/polish', scopes, zValidator('json', polishTextRequestSchema), async (c) => {
  const { name, description } = c.req.valid('json');
  const auth = c.get('auth') as AuthContext;
  const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  try {
    const data = await polishCatalogText({ name, description }, { userId: auth.user.id, orgId });
    return c.json({ data });
  } catch (err) {
    if (err instanceof EnrichmentError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});
