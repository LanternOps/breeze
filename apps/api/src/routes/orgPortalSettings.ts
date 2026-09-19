import type { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalBranding } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { updatePortalSettingsSchema, PORTAL_CHROME_ACCENT_KEYS } from '@breeze/shared';
import {
  PORTAL_VISIBILITY_FLAG_KEYS,
  onPortalFlagsChanged,
  type PortalVisibilityFlags
} from '../services/portal/portalFlags';

// Admin read/write for the org's customer-portal settings (portal_branding).
// Registered onto orgRoutes so it inherits orgRoutes' authMiddleware
// (mounting at the top-level api app would silently skip auth). The public
// portal lookup routes in routes/portal/branding.ts stay read-only/pre-auth;
// this is the only write surface. Visual branding (logo/colors) + customDomain
// are excluded by the strict schema — they ship with the domain-verification
// project. customCss IS writable here (#5952) — it is the canonical write
// path for portal_branding.custom_css; sanitisation lives in
// updatePortalSettingsSchema (@breeze/shared) so both this route and any
// future caller get the same rejection behavior.
//
// chromeAccent is extended in HERE rather than added to
// packages/shared's updatePortalSettingsSchema, so the enum key list
// (PORTAL_CHROME_ACCENT_KEYS) stays the single source of truth without a
// second copy drifting in the shared validator. `.extend()` on a `.strict()`
// zod object preserves both the unknown-key rejection and per-field
// validation (verified: unrecognized keys still 400, and an invalid enum
// value still 400).
const patchPortalSettingsSchema = updatePortalSettingsSchema.extend({
  chromeAccent: z.enum(PORTAL_CHROME_ACCENT_KEYS).nullable().optional()
});

const PORTAL_SETTINGS_DEFAULTS = {
  enableTickets: true,
  enableAssetCheckout: false, // parked — see schema/portal.ts
  enableDevices: false,
  enableSelfService: true,
  enablePasswordReset: true,
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  enableService: false,
  enableDocuments: false,
  enableLifecycle: false,
  enableNetworkVisibility: false,
  chromeAccent: null,
  supportEmail: null,
  supportPhone: null,
  welcomeMessage: null,
  footerText: null,
  customCss: null
} as const;

type PortalSettingsRow = {
  enableTickets: boolean;
  enableAssetCheckout: boolean;
  enableDevices: boolean;
  enableSelfService: boolean;
  enablePasswordReset: boolean;
  enableDashboard: boolean;
  enableSecurity: boolean;
  enableBackups: boolean;
  enableReports: boolean;
  enableSupportUsage: boolean;
  enableService: boolean;
  enableDocuments: boolean;
  enableLifecycle: boolean;
  enableNetworkVisibility: boolean;
  chromeAccent: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  welcomeMessage: string | null;
  footerText: string | null;
  customCss: string | null;
};

// Single projection used by BOTH the GET select and the PATCH .returning():
// every column not listed here (logoUrl, faviconUrl, primary/secondary/accent
// colors, customDomain, domainVerified) never reaches the app layer on either
// path, so a toResponse refactor can't accidentally leak them. customCss WAS
// in that excluded set before #5952; it is now part of the managed subset.
// A function, not a module-scope const: other route tests (orgs.test.ts etc.)
// mock ../db/schema without portalBranding, and an import-time column deref
// would crash their whole file at collection.
const portalSettingsColumns = () => ({
  enableTickets: portalBranding.enableTickets,
  enableAssetCheckout: portalBranding.enableAssetCheckout,
  enableDevices: portalBranding.enableDevices,
  enableSelfService: portalBranding.enableSelfService,
  enablePasswordReset: portalBranding.enablePasswordReset,
  enableDashboard: portalBranding.enableDashboard,
  enableSecurity: portalBranding.enableSecurity,
  enableBackups: portalBranding.enableBackups,
  enableReports: portalBranding.enableReports,
  enableSupportUsage: portalBranding.enableSupportUsage,
  enableService: portalBranding.enableService,
  enableDocuments: portalBranding.enableDocuments,
  enableLifecycle: portalBranding.enableLifecycle,
  enableNetworkVisibility: portalBranding.enableNetworkVisibility,
  chromeAccent: portalBranding.chromeAccent,
  supportEmail: portalBranding.supportEmail,
  supportPhone: portalBranding.supportPhone,
  welcomeMessage: portalBranding.welcomeMessage,
  footerText: portalBranding.footerText,
  customCss: portalBranding.customCss
});

function toResponse(orgId: string, row?: PortalSettingsRow) {
  if (!row) return { orgId, ...PORTAL_SETTINGS_DEFAULTS };
  return {
    orgId,
    enableTickets: row.enableTickets,
    enableAssetCheckout: row.enableAssetCheckout,
    enableDevices: row.enableDevices,
    enableSelfService: row.enableSelfService,
    enablePasswordReset: row.enablePasswordReset,
    enableDashboard: row.enableDashboard,
    enableSecurity: row.enableSecurity,
    enableBackups: row.enableBackups,
    enableReports: row.enableReports,
    enableSupportUsage: row.enableSupportUsage,
    enableService: row.enableService,
    enableDocuments: row.enableDocuments,
    enableLifecycle: row.enableLifecycle,
    enableNetworkVisibility: row.enableNetworkVisibility,
    chromeAccent: row.chromeAccent,
    supportEmail: row.supportEmail,
    supportPhone: row.supportPhone,
    welcomeMessage: row.welcomeMessage,
    footerText: row.footerText,
    customCss: row.customCss
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
        .select(portalSettingsColumns())
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
    zValidator('json', patchPortalSettingsSchema),
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
        .returning(portalSettingsColumns());

      if (!row) {
        return c.json({ error: 'Failed to persist portal settings' }, 500);
      }

      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.portal_settings.update',
        resourceType: 'organization',
        resourceId: org.id,
        details: { changedFields: Object.keys(body) }
      });

      const auth = c.get('auth') as AuthContext;
      const requested = Object.fromEntries(
        PORTAL_VISIBILITY_FLAG_KEYS
          .filter((key) => (body as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, (body as Record<string, unknown>)[key]])
      ) as Partial<PortalVisibilityFlags>;

      if (Object.keys(requested).length > 0) {
        await onPortalFlagsChanged({
          orgId: org.id,
          createdBy: auth.user.id,
          requested,
          current: {
            enableDashboard: row.enableDashboard,
            enableSecurity: row.enableSecurity,
            enableBackups: row.enableBackups,
            enableReports: row.enableReports,
            enableSupportUsage: row.enableSupportUsage,
            enableService: row.enableService,
            enableDocuments: row.enableDocuments,
            enableLifecycle: row.enableLifecycle,
            enableNetworkVisibility: row.enableNetworkVisibility
          }
        });
      }

      return c.json({ data: toResponse(org.id, row) });
    }
  );
}
