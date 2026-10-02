import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema } from '@breeze/shared';
import { db } from '../db';
import { organizations } from '../db/schema';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAuditOrgIdForPartner } from '../services/auditOrgResolver';
import { resolveBillingPaymentSettings, updatePartnerPaymentSettings, updateOrgPaymentSettings } from '../services/autopay/billingPaymentSettings';
import { isAutopayEnabledForPartner } from '../services/autopay/autopayGate';

import { paymentSettingsView } from '../services/autopay/paymentSettingsView';

export const billingPaymentSettingsRoutes = new Hono();
const writePermission = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const autopayFields = new Set(['autopayOffsetDays', 'autopayOffsetRule', 'autopayCapEnabled', 'autopayCapAmount', 'autopayCapCurrency', 'achMode']);
function partnerFrom(c: Context): string {
  const partnerId = c.get('auth')?.partnerId;
  if (!partnerId) throw new HTTPException(403, { message: 'Partner context required' });
  return partnerId;
}
async function orgPartner(c: Context, orgId: string): Promise<string> {
  const auth = c.get('auth');
  if (!auth.canAccessOrg(orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, orgId)).limit(1);
  if (!org || (auth.scope !== 'system' && org.partnerId !== auth.partnerId)) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }
  return org.partnerId;
}
async function refuseDisabledAutopay(c: Context, partnerId: string, patch: object): Promise<Response | undefined> {
  if (Object.keys(patch).some(key => autopayFields.has(key)) && !await isAutopayEnabledForPartner(db, partnerId)) {
    return c.json({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled' }, 404);
  }
}
billingPaymentSettingsRoutes.get('/partner/billing/payment-settings', authMiddleware, requireScope('partner'), async c => {
  const partnerId = partnerFrom(c);
  const view = await paymentSettingsView(db, partnerId);
  return c.json({ data: view.effective, ...view });
});
billingPaymentSettingsRoutes.put('/partner/billing/payment-settings', authMiddleware, requireScope('partner'), writePermission,
  zValidator('json', partnerPaymentSettingsPatchSchema), async c => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const partnerId = partnerFrom(c); const patch = c.req.valid('json');
    const refusal = await refuseDisabledAutopay(c, partnerId, patch); if (refusal) return refusal;
    await updatePartnerPaymentSettings(db, partnerId, patch, auth.user.id);
    writeRouteAudit(c as never, { orgId: await resolveAuditOrgIdForPartner(partnerId),
      action: 'partner.payment_settings.update', resourceType: 'partner', resourceId: partnerId,
      details: { changedFields: Object.keys(patch) } });
    return c.json({ data: await resolveBillingPaymentSettings(db, { partnerId }),
      autopayEnabled: await isAutopayEnabledForPartner(db, partnerId) });
  });
billingPaymentSettingsRoutes.get('/orgs/:orgId/billing/payment-settings', authMiddleware, requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', z.object({ orgId: z.string().guid() })), async c => {
    const { orgId } = c.req.valid('param'); const partnerId = await orgPartner(c, orgId);
    const view = await paymentSettingsView(db, partnerId, orgId);
    return c.json({ data: view.effective, ...view });
  });
billingPaymentSettingsRoutes.put('/orgs/:orgId/billing/payment-settings', authMiddleware, requireScope('partner', 'system'), writePermission, requireMfa(),
  zValidator('param', z.object({ orgId: z.string().guid() })), zValidator('json', orgPaymentSettingsPatchSchema), async c => {
    const { orgId } = c.req.valid('param'); const partnerId = await orgPartner(c, orgId); const patch = c.req.valid('json');
    const refusal = await refuseDisabledAutopay(c, partnerId, patch); if (refusal) return refusal;
    await updateOrgPaymentSettings(db, orgId, patch, c.get('auth').user.id);
    writeRouteAudit(c as never, { orgId, action: 'organization.payment_settings.update', resourceType: 'organization',
      resourceId: orgId, details: { changedFields: Object.keys(patch) } });
    return c.json({ data: await resolveBillingPaymentSettings(db, { partnerId, orgId }) });
  });
