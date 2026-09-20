import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';
import { MONITOR_CONVERSION_SOURCE_TABLES } from '../db/schema/monitorConversions';
import {
  previewPolicyConversion, convertPolicy, revertConversion, retireSource,
  convertPartnerLegacy, previewPartnerConversion, listConversionLedger, countPendingConversions,
  ConversionError, ConversionPrerequisiteMissingError,
} from '../services/monitors/conversion';

type Env = { Variables: { auth: AuthContext } };
export const monitorConversionRoutes = new Hono<Env>();
// Also authenticated when mounted in isolation by tools/tests. The real auth
// middleware already short-circuits an existing authenticated context.
monitorConversionRoutes.use('*', authMiddleware);
monitorConversionRoutes.use('*', requireScope('organization', 'partner', 'system'));
const read = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const write = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
const governance: MiddlewareHandler<Env> = async (c, next) => {
  if (!canMutateOrgWideGovernance(c.get('auth'))) {
    return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
  }
  await next();
};
const policyParam = z.object({ policyId: z.string().uuid() });
const conversionParam = z.object({ conversionId: z.string().uuid() });
const convertBody = z.object({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
}).strict();
const retireBody = z.object({
  sourceTable: z.enum(MONITOR_CONVERSION_SOURCE_TABLES),
  sourceId: z.string().uuid(),
  reason: z.string().max(200).regex(/^(operator|unconvertible:[a-z][a-z0-9_]*)$/),
}).strict();

monitorConversionRoutes.onError((error, c) => {
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

monitorConversionRoutes.post('/partner/preview', read, governance, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  if (!auth.partnerId) return c.json({ error: 'Select a partner' }, 400);
  return c.json({ data: await previewPartnerConversion(auth.partnerId, auth) });
});
monitorConversionRoutes.get('/ledger', read,
  zValidator('query', z.object({ orgId: z.string().uuid().optional(), policyId: z.string().uuid().optional(),
    cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })), async (c) => {
    return c.json(await listConversionLedger(c.req.valid('query'), c.get('auth')));
  });
monitorConversionRoutes.get('/pending', read,
  zValidator('query', z.object({ orgId: z.string().uuid().optional() })), async (c) => {
    const auth = c.get('auth');
    const orgId = c.req.valid('query').orgId ?? auth.orgId;
    if (orgId && !auth.canAccessOrg(orgId)) return c.json({ error: 'Organization access denied' }, 403);
    if (!orgId && !auth.partnerId) return c.json({ error: 'Select an organization or partner' }, 400);
    const counts = await countPendingConversions({
      orgId, partnerId: auth.partnerId,
      includePartnerWide: canManagePartnerWidePolicies(auth),
    });
    return c.json({ data: { policies: counts.policies, rows: counts.rows } });
  });
monitorConversionRoutes.get('/policies/:policyId/preview', read,
  zValidator('param', policyParam), async (c) => {
    const data = await previewPolicyConversion(c.req.valid('param').policyId, c.get('auth'));
    return c.json({ data }, 'status' in data && data.status === 'running' ? 202 : 200);
  });
monitorConversionRoutes.post('/policies/:policyId/convert', write, requireMfa(), governance,
  zValidator('param', policyParam), zValidator('json', convertBody), async (c) => {
    const { policyId } = c.req.valid('param');
    const { previewHash, sourceIds } = c.req.valid('json');
    const data = await convertPolicy(policyId, previewHash, c.get('auth'), { sourceIds });
    writeRouteAudit(c, { orgId: undefined, action: 'monitor.conversion.convert', resourceType: 'configuration_policy', resourceId: policyId, details: data });
    return c.json({ data });
  });
monitorConversionRoutes.post('/partner/convert-all', write, requireMfa(), governance,
  zValidator('json', z.object({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()), async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  if (!auth.partnerId) return c.json({ error: 'Select a partner' }, 400);
  const data = await convertPartnerLegacy(auth.partnerId, c.req.valid('json').previewHash, auth);
  writeRouteAudit(c, { orgId: undefined, action: 'monitor.conversion.convert_all', resourceType: 'partner', resourceId: auth.partnerId, details: data });
  return c.json({ data });
});
monitorConversionRoutes.post('/retire', write, requireMfa(), governance,
  zValidator('json', retireBody), async (c) => {
    const { sourceTable, sourceId, reason } = c.req.valid('json');
    const { conversionId } = await retireSource(sourceTable, sourceId, reason, c.get('auth'));
    writeRouteAudit(c, { orgId: undefined, action: 'monitor.conversion.retire', resourceType: sourceTable, resourceId: sourceId, details: { reason, conversionId } });
    return c.json({ success: true, conversionId });
  });
monitorConversionRoutes.post('/:conversionId/revert', write, requireMfa(), governance,
  zValidator('param', conversionParam), async (c) => {
    const { conversionId } = c.req.valid('param');
    await revertConversion(conversionId, c.get('auth'));
    writeRouteAudit(c, { orgId: undefined, action: 'monitor.conversion.revert', resourceType: 'monitor_conversion', resourceId: conversionId });
    return c.json({ success: true });
  });
