import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { partnerTicketApprovalSettingsPatchSchema, orgTicketApprovalSettingsPatchSchema } from '@breeze/shared';
import { db } from '../../db';
import { organizations } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveAuditOrgIdForPartner } from '../../services/auditOrgResolver';
import {
  resolveTicketApprovalSettings,
  updatePartnerTicketApprovalSettings,
  updateOrgTicketApprovalSettings,
} from '../../services/ticketApproval/settings';

/**
 * Customer work approval policy (#4617 spec §4.1, §7): partner default and org
 * override. Both GETs return the resolved value AND its source per field, so
 * the UI can show the inherited value and where it comes from.
 *
 * Gates mirror the existing ticketing settings homes: the partner row uses the
 * partner-settings gate (orgs:write + MFA + canManagePartnerWidePolicies, as
 * PATCH /orgs/partners/me), the org row uses the org Ticketing settings gate
 * (orgs:write + MFA, as PATCH /orgs/organizations/:id/ticket-settings).
 *
 * Mounted at '/' with absolute paths, so authMiddleware leads each route's own
 * chain instead of a router-level `.use('*')` (the #1383 footgun).
 */
export const ticketApprovalSettingsRoutes = new Hono();

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const orgParam = zValidator('param', z.object({ orgId: z.string().guid() }));

function partnerFrom(c: Context): string {
  const partnerId = (c.get('auth') as AuthContext | undefined)?.partnerId;
  if (!partnerId) throw new HTTPException(403, { message: 'Partner context required' });
  return partnerId;
}

/** The org's partner, after confirming the caller may act on the org. */
async function orgPartner(c: Context, orgId: string): Promise<string> {
  const auth = c.get('auth') as AuthContext;
  if (!auth.canAccessOrg(orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, orgId)).limit(1);
  if (!org || (auth.scope !== 'system' && org.partnerId !== auth.partnerId)) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }
  return org.partnerId;
}

ticketApprovalSettingsRoutes.get('/ticketing/approval-settings',
  authMiddleware, requireScope('partner'), requireOrgRead,
  async (c) => {
    const partnerId = partnerFrom(c);
    return c.json({ data: await resolveTicketApprovalSettings(db, { partnerId }) });
  });

ticketApprovalSettingsRoutes.patch('/ticketing/approval-settings',
  authMiddleware, requireScope('partner'), requireOrgWrite, requireMfa(),
  zValidator('json', partnerTicketApprovalSettingsPatchSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const partnerId = partnerFrom(c);
    const patch = c.req.valid('json');
    await updatePartnerTicketApprovalSettings(db, partnerId, patch);
    writeRouteAudit(c as never, {
      orgId: await resolveAuditOrgIdForPartner(partnerId),
      action: 'partner.ticket_approval_settings.update',
      resourceType: 'partner',
      resourceId: partnerId,
      details: { changedFields: Object.keys(patch) },
    });
    return c.json({ data: await resolveTicketApprovalSettings(db, { partnerId }) });
  });

ticketApprovalSettingsRoutes.get('/orgs/:orgId/ticketing/approval-settings',
  authMiddleware, requireScope('partner', 'system'), requireOrgRead, orgParam,
  async (c) => {
    const { orgId } = c.req.valid('param');
    const partnerId = await orgPartner(c, orgId);
    return c.json({ data: await resolveTicketApprovalSettings(db, { partnerId, orgId }) });
  });

ticketApprovalSettingsRoutes.patch('/orgs/:orgId/ticketing/approval-settings',
  authMiddleware, requireScope('partner', 'system'), requireOrgWrite, requireMfa(), orgParam,
  zValidator('json', orgTicketApprovalSettingsPatchSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const partnerId = await orgPartner(c, orgId);
    const patch = c.req.valid('json');
    await updateOrgTicketApprovalSettings(db, orgId, patch);
    writeRouteAudit(c as never, {
      orgId,
      action: 'organization.ticket_approval_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: { changedFields: Object.keys(patch) },
    });
    return c.json({ data: await resolveTicketApprovalSettings(db, { partnerId, orgId }) });
  });
