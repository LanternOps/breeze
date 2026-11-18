import type { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { ERROR_CODES } from '@breeze/shared';
import {
  applyOrgPortalSettings,
  getOrgPortalSettings,
  patchPortalSettingsSchema
} from '../services/orgPortalSettingsService';

// Admin read/write for the org's customer-portal settings (portal_branding).
// Registered onto orgRoutes so it inherits orgRoutes' authMiddleware
// (mounting at the top-level api app would silently skip auth). The public
// portal lookup routes in routes/portal/branding.ts stay read-only/pre-auth;
// this is the only write surface. Favicon, accent colour and customDomain are
// excluded by the strict schema — they ship with the domain-verification
// project. primaryColor (#9962), secondaryColor and logoUrl (#9673) ARE writable
// here: they are the org overrides of the partner's Branding, edited on the org
// Branding tab. customCss IS writable here (#5952) — it is the canonical write
// path for portal_branding.custom_css; sanitisation lives in
// updatePortalSettingsSchema (@breeze/shared) so both this route and any
// future caller get the same rejection behavior.
//
// The projection, defaults, upsert and report-provisioning hook live in
// services/orgPortalSettingsService.ts, shared with the
// manage_org_portal_settings AI tool (full-control W18 PR B, #6789).
export async function resolveAccessibleOrg(c: any): Promise<{ id: string; partnerId: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found', code: ERROR_CODES.NOT_FOUND }, 404);
  }
  const orgRows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
    .limit(1);
  if (!orgRows[0]) {
    return c.json({ error: 'Organization not found', code: ERROR_CODES.NOT_FOUND }, 404);
  }
  return { id, partnerId: orgRows[0].partnerId };
}

export function registerOrgPortalSettingsRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-settings',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      return c.json({ data: await getOrgPortalSettings(org) });
    }
  );

  orgRoutes.patch(
    '/organizations/:id/portal-settings',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', patchPortalSettingsSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (Object.keys(body).length === 0) {
        return c.json({ error: 'No updates provided', code: ERROR_CODES.NO_UPDATES_PROVIDED }, 400);
      }
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const auth = c.get('auth') as AuthContext;
      // The audit row is written once the upsert lands and before the
      // report-provisioning hook, the order this route always used.
      const result = await applyOrgPortalSettings(org.id, body, auth.user.id, {
        onPersisted: () => writeRouteAudit(c, {
          orgId: org.id,
          action: 'organization.portal_settings.update',
          resourceType: 'organization',
          resourceId: org.id,
          details: { changedFields: Object.keys(body) }
        })
      });
      if (!result.ok) {
        return c.json({ error: 'Failed to persist portal settings' }, 500);
      }

      return c.json({ data: result.settings });
    }
  );
}
