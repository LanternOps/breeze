import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { createSystemAuthContext } from '../../services/featureConfigResolver';
import { convertPartnerLegacy, previewPartnerConversion, ConversionError, ConversionPrerequisiteMissingError } from '../../services/monitors/conversion';
import { listPartnerConversionBacklog } from '../../services/monitors/conversion/partnerBacklog';

/**
 * Platform-admin surface for the W05c hosted sweep (spec §Conversion "Who runs
 * it"): list every partner's unretired legacy rows and run the partner-level
 * converter for one partner. Mounted UNDER platformAdminMiddleware by
 * routes/admin/index.ts — the gate is deliberately not repeated here
 * (routes/admin/index.ts:16). MFA on the mutating verb, like tenant-erasure.
 */
export const adminMonitorConversionRoutes = new Hono();

adminMonitorConversionRoutes.onError((error, c) => {
  if (error instanceof ConversionPrerequisiteMissingError) {
    return c.json({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: error.missing }, 409);
  }
  if (!(error instanceof ConversionError)) throw error;
  if (error.code === 'prerequisite_missing') {
    return c.json({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: Array.isArray(error.details) ? error.details : [] }, 409);
  }
  const status = error.code === 'partner_wide_denied' ? 403
    : ['policy_not_found', 'source_not_found', 'conversion_not_found'].includes(error.code) ? 404
    : error.code === 'invalid_reason' ? 400 : 409;
  return c.json({ error: error.code, message: error.message, details: error.details }, status);
});

const partnerParam = z.object({ partnerId: z.string().uuid() });

/**
 * System scope supplies the partner-wide capability. C1 persists null in
 * converted_by / created_by for system scope even when auth.user is real.
 * Carry the admin user for request context; writeRouteAudit on the original
 * context records that administrator. Never persist the synthetic user id.
 */
export function adminAuthForPartner(auth: AuthContext, partnerId: string): AuthContext {
  return {
    ...createSystemAuthContext(),
    user: auth.user,
    partnerId,
    partnerOrgAccess: 'all',
  };
}

adminMonitorConversionRoutes.get('/partners', async (c) => {
  const data = await listPartnerConversionBacklog();
  return c.json({ data });
});

adminMonitorConversionRoutes.post('/partners/:partnerId/preview', requireMfa(), zValidator('param', partnerParam), async (c) => {
  const { partnerId } = c.req.valid('param');
  // Self-managed route (SELF_MANAGED_DB_CONTEXT_ROUTES): the converter opens its
  // own serializable, system-scoped transaction from the auth it is handed. Call
  // it bare — any ambient context here trips assertIsolationNotNested (D30).
  const data = await previewPartnerConversion(partnerId, adminAuthForPartner(c.get('auth') as AuthContext, partnerId));
  return c.json({ data });
});

adminMonitorConversionRoutes.post('/partners/:partnerId/convert', requireMfa(), zValidator('param', partnerParam), zValidator('json', z.object({ previewHash: z.string().min(1) })), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { partnerId } = c.req.valid('param');
  // Self-managed route: call the converter bare, see the preview handler above.
  const result = await convertPartnerLegacy(partnerId, c.req.valid('json').previewHash, adminAuthForPartner(auth, partnerId));
  writeRouteAudit(c as never, {
    orgId: null,
    action: 'monitor_conversion.admin_partner_convert',
    resourceType: 'partner',
    resourceId: partnerId,
    details: result,
  });
  return c.json({ data: result });
});

