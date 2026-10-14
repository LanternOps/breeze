import type { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { contacts, devices, sites } from '../db/schema';
import { zValidator } from '../lib/validation';
import { requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { CONTACT_ROLES } from '../services/contacts/types';
import { resolveContactResponsibility } from '../services/contacts/responsibilities';
import { resolveAccessibleOrg } from './orgContacts';

/**
 * Read-only "who to contact" (spec 2026-10-06 contact-responsibility-scope, §14 follow-up).
 *
 * Returns the responsibilities that resolve for one Site or one Device, using the
 * canonical resolver (Device Group > Site > Organization). No writes.
 *
 * Gate matches the contacts CRUD: ORGS_READ. Site reach is re-asserted with
 * auth.canAccessSite, and every not-found/not-reachable case returns 404 so the
 * response is not an existence oracle.
 */

const querySchema = z
  .object({
    siteId: z.string().guid().optional(),
    deviceId: z.string().guid().optional(),
  })
  .refine((q) => Boolean(q.siteId) !== Boolean(q.deviceId), {
    message: 'Provide exactly one of siteId or deviceId',
  });

export function registerOrgContactResponsibilitiesRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

  orgRoutes.get(
    '/organizations/:id/contact-responsibilities',
    requireScope('organization', 'partner', 'system'),
    requireOrgRead,
    zValidator('query', querySchema),
    async (c) => {
      const auth = c.get('auth') as AuthContext;
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const { siteId, deviceId } = c.req.valid('query');
      let targetSiteId: string | null = null;

      if (deviceId) {
        const rows = await db
          .select({ siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, org.id)))
          .limit(1);
        if (!rows[0]) return c.json({ error: 'Device not found' }, 404);
        targetSiteId = rows[0].siteId;
      } else if (siteId) {
        const rows = await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, siteId), eq(sites.orgId, org.id)))
          .limit(1);
        if (!rows[0]) return c.json({ error: 'Site not found' }, 404);
        targetSiteId = siteId;
      }

      if (!(auth.canAccessSite?.(targetSiteId) ?? true)) return c.json({ error: 'Site not found' }, 404);

      const resolved = [];
      for (const role of CONTACT_ROLES) {
        const result = await resolveContactResponsibility(db, {
          orgId: org.id,
          role,
          siteId: targetSiteId,
          deviceId: deviceId,
        });
        if (result.assignments.length === 0) continue;
        resolved.push({ role, level: result.level, assignments: result.assignments });
      }

      const contactIds = [...new Set(resolved.flatMap((r) => r.assignments.map((a) => a.contactId)))];
      const details = contactIds.length === 0
        ? []
        : await db
            .select({
              id: contacts.id,
              name: contacts.name,
              email: contacts.email,
              phone: contacts.phone,
              mobile: contacts.mobile,
              title: contacts.title,
            })
            .from(contacts)
            .where(and(eq(contacts.orgId, org.id), inArray(contacts.id, contactIds)));
      const byId = new Map(details.map((row) => [row.id, row]));

      return c.json({
        responsibilities: resolved.map((r) => ({
          role: r.role,
          level: r.level,
          contacts: r.assignments.flatMap((a) => {
            const detail = byId.get(a.contactId);
            if (!detail) return [];
            return [{
              contactId: a.contactId,
              name: detail.name,
              email: detail.email,
              phone: detail.phone,
              mobile: detail.mobile,
              title: detail.title,
              isPrimary: a.isPrimary,
            }];
          }),
        })).filter((r) => r.contacts.length > 0),
      });
    },
  );
}
