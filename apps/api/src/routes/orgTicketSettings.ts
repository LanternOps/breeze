import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { orgTicketSettingsSchema } from '@breeze/shared';
import { getOrgTicketSettings, upsertOrgTicketSettings } from '../services/ticketConfigService';

// Admin read/write for an org's ticketing overrides (org_ticket_settings:
// SLA override map + billing defaults). Registered onto orgRoutes so it
// inherits orgRoutes' authMiddleware — mounting at the top-level api app would
// silently skip auth. Mirrors orgPortalSettings.ts.

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

export function registerOrgTicketSettingsRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/ticket-settings',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const data = await getOrgTicketSettings(org.id);
      return c.json({ data });
    }
  );

  orgRoutes.patch(
    '/organizations/:id/ticket-settings',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', orgTicketSettingsSchema),
    async (c) => {
      const body = c.req.valid('json');
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const data = await upsertOrgTicketSettings(org.id, body);

      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.ticket_settings.update',
        resourceType: 'organization',
        resourceId: org.id,
        details: { changedFields: Object.keys(body) }
      });

      return c.json({ data });
    }
  );
}
