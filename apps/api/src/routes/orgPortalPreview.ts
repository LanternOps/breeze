import type { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { portalUsers } from '../db/schema';
import { requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { ERROR_CODES } from '@breeze/shared';
import { buildPortalPreview, type PreviewPortalUser } from '../services/portal/portalPreview';
import { resolveAccessibleOrg } from './orgPortalSettings';

// Staff "Customer view" (#9350, decision (a)): a READ-ONLY render of the portal
// read models for one org, through the same gate table the portal routes use
// (routes/portal/featureFlags.ts PORTAL_SECTION_GATES).
//
// Hard rules, each pinned by orgPortalPreview.test.ts:
//  - runs under the caller's request DB context (no system/outside context);
//  - never mints a portal session, token or JWT;
//  - writes exactly one audit event and nothing else (no viewed/read stamps);
//  - site-restricted staff are refused: portal data is org-wide and would
//    exceed their access.
const previewQuery = z.object({
  portalUserId: z.string().uuid().optional(),
});

export function registerOrgPortalPreviewRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

  orgRoutes.get(
    '/organizations/:id/portal-preview',
    requireScope('partner', 'system'),
    requireOrgRead,
    zValidator('query', previewQuery),
    async (c) => {
      const perms = c.get('permissions') as UserPermissions | undefined;
      if (Array.isArray(perms?.allowedSiteIds)) {
        return c.json({
          error: 'Site-restricted users cannot preview the customer portal: its data is organization-wide',
          code: ERROR_CODES.ACCESS_DENIED,
        }, 403);
      }

      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const { portalUserId } = c.req.valid('query');
      let portalUser: PreviewPortalUser | null = null;
      if (portalUserId) {
        // Org-scoped lookup: another org's user is indistinguishable from a
        // missing one (404), never a 403 that confirms it exists.
        const [row] = await db
          .select({
            id: portalUsers.id,
            contactId: portalUsers.contactId,
            name: portalUsers.name,
            email: portalUsers.email,
          })
          .from(portalUsers)
          .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.orgId, org.id)))
          .limit(1);
        if (!row) {
          return c.json({ error: 'Portal user not found', code: ERROR_CODES.NOT_FOUND }, 404);
        }
        portalUser = row;
      }

      const data = await buildPortalPreview({ orgId: org.id, portalUser });

      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.portal_preview.view',
        resourceType: 'organization',
        resourceId: org.id,
        details: { portalUserId: portalUser?.id ?? null },
      });

      c.header('Cache-Control', 'no-store');
      return c.json({ data });
    },
  );
}
