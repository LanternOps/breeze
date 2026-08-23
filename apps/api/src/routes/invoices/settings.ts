import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { partnerBillingSettingsSchema, orgBillingSettingsSchema, orgCurrencyImpactQuerySchema } from '@breeze/shared';
import { updatePartnerBillingSettings, updateOrgBillingSettings } from '../../services/invoiceService';
import { getOrgCurrencyImpact } from '../../services/orgCurrencyService';
import { invoiceActorFrom, handleServiceError } from './invoices';

// Mounted at the api root (not under the /invoices hub) so the paths read
// /api/v1/partner/billing-settings and /api/v1/orgs/:orgId/billing-settings.
// Auth is applied PER-ROUTE (not via `use('*')`): mounted at '/', a wildcard
// middleware would leak onto sibling/public routes registered later and 401 them
// (the #1383 regression). authMiddleware leads each route's middleware chain.
export const invoiceSettingsRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);

invoiceSettingsRoutes.patch('/partner/billing-settings', authMiddleware, scopes, writePerm,
  zValidator('json', partnerBillingSettingsSchema),
  async (c) => {
    try { return c.json({ data: await updatePartnerBillingSettings(c.req.valid('json'), invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });

invoiceSettingsRoutes.patch('/orgs/:orgId/billing-settings', authMiddleware, scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().guid() })),
  zValidator('json', orgBillingSettingsSchema),
  async (c) => {
    try { return c.json({ data: await updateOrgBillingSettings(c.req.valid('param').orgId, c.req.valid('json'), invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });

// Multi-currency wave 6 (#3778): ADVISORY, read-only preview of what a currency
// change would strand. Counts are never blockers and never a promise — rows can
// be created between this preview and the change (the org SHARE barrier, not
// this count, is what makes the cutover exact). Same per-route middleware chain
// as the PATCH above (never `use('*')` — the #1383 regression).
invoiceSettingsRoutes.get('/orgs/:orgId/billing-settings/currency-impact', authMiddleware, scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().guid() })),
  zValidator('query', orgCurrencyImpactQuerySchema),
  async (c) => {
    try {
      return c.json({ data: await getOrgCurrencyImpact(
        c.req.valid('param').orgId, c.req.valid('query').currencyCode, invoiceActorFrom(c)) });
    } catch (err) { return handleServiceError(c, err); }
  });
