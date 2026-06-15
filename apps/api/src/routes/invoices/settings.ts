import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { partnerBillingSettingsSchema, orgBillingSettingsSchema } from '@breeze/shared';
import { updatePartnerBillingSettings, updateOrgBillingSettings } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

// Mounted at the api root (not under the /invoices hub) so the paths read
// /api/v1/partner/billing-settings and /api/v1/orgs/:orgId/billing-settings.
// It applies authMiddleware itself, mirroring invoiceAssemblyRoutes.
export const invoiceSettingsRoutes = new Hono();
invoiceSettingsRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);

invoiceSettingsRoutes.patch('/partner/billing-settings', scopes, writePerm,
  zValidator('json', partnerBillingSettingsSchema),
  async (c) => {
    try { return c.json({ data: await updatePartnerBillingSettings(c.req.valid('json'), invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });

invoiceSettingsRoutes.patch('/orgs/:orgId/billing-settings', scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().uuid() })),
  zValidator('json', orgBillingSettingsSchema),
  async (c) => {
    try { return c.json({ data: await updateOrgBillingSettings(c.req.valid('param').orgId, c.req.valid('json'), invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
