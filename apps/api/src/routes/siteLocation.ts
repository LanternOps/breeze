import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { ERROR_CODES, siteLocationPinSchema } from '@breeze/shared';
import { db } from '../db';
import { organizations, sites } from '../db/schema';
import { requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { isHiddenOrgType } from '../services/unassignedPool/visibility';
import { isHoldingOrg } from '../services/unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from '../services/unassignedPool/orgType';
import { pinSiteLocation } from '../services/siteLocationPin';
import { ensureOrgAccess } from './devices/helpers';

/**
 * Mounted from routes/orgs.ts AFTER `orgRoutes.use('*', authMiddleware)`, so
 * authentication is inherited from the parent; this router adds none of its own.
 */
export const siteLocationRoutes = new Hono();

const requireSetLocation = requirePermission(
  PERMISSIONS.SITES_SET_LOCATION.resource,
  PERMISSIONS.SITES_SET_LOCATION.action,
);

// Deliberately NO requireMfa(): a site coordinate is not credential material and
// a field tech pins it from the phone (spec §3, Gate A Q2). Every other site
// field stays behind PATCH /sites/:id + requireMfa().
siteLocationRoutes.post(
  '/sites/:id/location',
  requireScope('organization', 'partner', 'system'),
  requireSetLocation,
  zValidator('param', z.object({ id: z.string().guid() })),
  zValidator('json', siteLocationPinSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const [site] = await db
      .select({ id: sites.id, orgId: sites.orgId, name: sites.name })
      .from(sites)
      .where(eq(sites.id, id))
      .limit(1);
    if (!site) {
      return c.json({ error: 'Site not found', code: ERROR_CODES.NOT_FOUND }, 404);
    }

    if (!(await ensureOrgAccess(site.orgId, auth))) {
      return c.json({ error: 'Access to this site denied', code: ERROR_CODES.ACCESS_DENIED }, 403);
    }

    const [org] = await db
      .select({ type: organizations.type, deletedAt: organizations.deletedAt })
      .from(organizations)
      .where(eq(organizations.id, site.orgId))
      .limit(1);
    // Soft-deleted org: indistinguishable from a missing site (no existence oracle).
    if (!org || org.deletedAt) {
      return c.json({ error: 'Site not found', code: ERROR_CODES.NOT_FOUND }, 404);
    }
    // Quick Support / holding orgs are hidden and not user-managed.
    if (isHiddenOrgType(org.type)) {
      return c.json(PROTECTED_ORG_ERROR, 409);
    }

    // The unassigned-device holding org is managed by Breeze.
    if (await isHoldingOrg(site.orgId)) {
      return c.json(PROTECTED_ORG_ERROR, 409);
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds && !canAccessSite(permissions, site.id)) {
      return c.json({ error: 'Access to this site denied', code: ERROR_CODES.ACCESS_DENIED }, 403);
    }

    const body = c.req.valid('json');
    const updated = await pinSiteLocation(site.id, body, auth.user.id);
    // 0-row write: the RLS UPDATE policy rejected it despite the SELECT passing,
    // or the site was deleted between the read and the write.
    if (!updated) {
      console.error('[siteLocation] pin write matched no row', { siteId: site.id, orgId: site.orgId, userId: auth.user.id });
      return c.json({ error: 'Failed to update site' }, 500);
    }

    writeRouteAudit(c, {
      orgId: site.orgId,
      action: 'site.location_set',
      resourceType: 'site',
      resourceId: site.id,
      resourceName: site.name,
      details: {
        latitude: body.latitude,
        longitude: body.longitude,
        geofenceRadiusM: body.geofenceRadiusM ?? null,
      },
    });

    return c.json({ data: updated });
  },
);
