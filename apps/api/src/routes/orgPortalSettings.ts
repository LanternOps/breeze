import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalBranding } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { updatePortalSettingsSchema } from '@breeze/shared';

// Admin read/write for the org's customer-portal settings (portal_branding).
// Registered onto orgRoutes so it inherits orgRoutes' authMiddleware
// (mounting at the top-level api app would silently skip auth). The public
// portal lookup routes in routes/portal/branding.ts stay read-only/pre-auth;
// this is the only write surface. Visual branding + customDomain are excluded
// by the strict schema — they ship with the domain-verification project.

const PORTAL_SETTINGS_DEFAULTS = {
  enableTickets: true,
  enableAssetCheckout: true,
  enableSelfService: true,
  enablePasswordReset: true,
  supportEmail: null,
  supportPhone: null,
  welcomeMessage: null,
  footerText: null
} as const;

type PortalSettingsRow = {
  enableTickets: boolean;
  enableAssetCheckout: boolean;
  enableSelfService: boolean;
  enablePasswordReset: boolean;
  supportEmail: string | null;
  supportPhone: string | null;
  welcomeMessage: string | null;
  footerText: string | null;
};

// Single projection used by BOTH the GET select and the PATCH .returning():
// every column not listed here (logoUrl, faviconUrl, primary/secondary/accent
// colors, customCss, customDomain, domainVerified) never reaches the app
// layer on either path, so a toResponse refactor can't accidentally leak them.
const PORTAL_SETTINGS_COLUMNS = {
  enableTickets: portalBranding.enableTickets,
  enableAssetCheckout: portalBranding.enableAssetCheckout,
  enableSelfService: portalBranding.enableSelfService,
  enablePasswordReset: portalBranding.enablePasswordReset,
  supportEmail: portalBranding.supportEmail,
  supportPhone: portalBranding.supportPhone,
  welcomeMessage: portalBranding.welcomeMessage,
  footerText: portalBranding.footerText
};

function toResponse(orgId: string, row?: PortalSettingsRow) {
  if (!row) return { orgId, ...PORTAL_SETTINGS_DEFAULTS };
  return {
    orgId,
    enableTickets: row.enableTickets,
    enableAssetCheckout: row.enableAssetCheckout,
    enableSelfService: row.enableSelfService,
    enablePasswordReset: row.enablePasswordReset,
    supportEmail: row.supportEmail,
    supportPhone: row.supportPhone,
    welcomeMessage: row.welcomeMessage,
    footerText: row.footerText
  };
}

async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  const orgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
    .limit(1);
  if (!orgRows[0]) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  return { id };
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

      const rows = await db
        .select(PORTAL_SETTINGS_COLUMNS)
        .from(portalBranding)
        .where(eq(portalBranding.orgId, org.id))
        .limit(1);
      // No auto-insert on read: defaults are reported until the first PATCH.
      return c.json({ data: toResponse(org.id, rows[0]) });
    }
  );

  orgRoutes.patch(
    '/organizations/:id/portal-settings',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', updatePortalSettingsSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (Object.keys(body).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      // portal_branding has UNIQUE(org_id) — upsert keeps first-write and
      // subsequent edits on one code path.
      const [row] = await db
        .insert(portalBranding)
        .values({ orgId: org.id, ...body })
        .onConflictDoUpdate({
          target: portalBranding.orgId,
          set: { ...body, updatedAt: new Date() }
        })
        .returning(PORTAL_SETTINGS_COLUMNS);

      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.portal_settings.update',
        resourceType: 'organization',
        resourceId: org.id,
        details: { changedFields: Object.keys(body) }
      });

      return c.json({ data: toResponse(org.id, row) });
    }
  );
}
