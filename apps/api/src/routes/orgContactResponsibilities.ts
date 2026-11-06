import type { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { contacts, devices, sites } from '../db/schema';
import { zValidator } from '../lib/validation';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { CONTACT_ROLES } from '../services/contacts/types';
import {
  listContactResponsibilities,
  resolveContactResponsibility,
  ResponsibilityValidationError,
  setContactResponsibilities,
} from '../services/contacts/responsibilities';
import { writeContactAudit } from '../services/contacts/audit';
import { canReachContactSite, resolveAccessibleOrg, resolveContactOrg, validationResponse } from './orgContacts';

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

/**
 * Whole-set replace body (spec §21). The scope is a strict discriminated union,
 * so a Site and a Device Group cannot be expressed in one assignment.
 */
const MAX_RESPONSIBILITIES = 200;

const scopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('site'), siteId: z.string().guid() }).strict(),
  z.object({ type: z.literal('device_group'), deviceGroupId: z.string().guid() }).strict(),
]);

const setResponsibilitiesSchema = z
  .object({
    responsibilities: z
      .array(
        z
          .object({
            role: z.enum(CONTACT_ROLES),
            scope: scopeSchema,
            isPrimary: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_RESPONSIBILITIES),
  })
  .strict();

function serializeScope(row: { siteId: string | null; deviceGroupId: string | null }) {
  if (row.siteId) return { type: 'site' as const, siteId: row.siteId };
  if (row.deviceGroupId) return { type: 'device_group' as const, deviceGroupId: row.deviceGroupId };
  return { type: 'organization' as const };
}

export function registerOrgContactResponsibilitiesRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  const currentSet = async (contactId: string, orgId: string, auth: AuthContext) => {
    const rows = await listContactResponsibilities(db, { contactId, orgId });
    return {
      // A site-confined caller never sees the ids of Sites it cannot reach.
      responsibilities: rows.filter((row) => canReachContactSite(auth, row.siteId)).map((row) => ({
        role: row.role,
        scope: serializeScope(row),
        isPrimary: row.isPrimary,
      })),
    };
  };

  // Configured (not resolved) assignments of one contact.
  orgRoutes.get(
    '/contacts/:contactId/responsibilities',
    requireScope('organization', 'partner', 'system'),
    requireOrgRead,
    async (c) => {
      const resolved = await resolveContactOrg(c);
      if (resolved instanceof Response) return resolved;
      return c.json(await currentSet(resolved.contactId, resolved.orgId, c.get('auth') as AuthContext));
    },
  );

  // Replace the contact's whole set. A site-confined caller cannot see or
  // safely replace Organization-wide / foreign-Site rows, so it is refused.
  orgRoutes.put(
    '/contacts/:contactId/responsibilities',
    requireScope('organization', 'partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', setResponsibilitiesSchema),
    async (c) => {
      const auth = c.get('auth') as AuthContext;
      if (auth.allowedSiteIds) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      const resolved = await resolveContactOrg(c);
      if (resolved instanceof Response) return resolved;
      const { responsibilities } = c.req.valid('json');

      try {
        await setContactResponsibilities(db, {
          contactId: resolved.contactId,
          orgId: resolved.orgId,
          responsibilities,
        });
      } catch (err) {
        // contact-not-in-org (lost a race with a delete) is a 404, not a 400.
        if (err instanceof ResponsibilityValidationError && err.code === 'contact-not-in-org') {
          return c.json({ error: 'Contact not found' }, 404);
        }
        const refusal = validationResponse(c, err);
        if (refusal) return refusal;
        throw err;
      }

      const byRole: Record<string, number> = {};
      const byScope: Record<string, number> = {};
      for (const item of responsibilities) {
        byRole[item.role] = (byRole[item.role] ?? 0) + 1;
        byScope[item.scope.type] = (byScope[item.scope.type] ?? 0) + 1;
      }
      writeContactAudit(c, {
        orgId: resolved.orgId,
        action: 'contact.update',
        contactId: resolved.contactId,
        details: { changedFields: ['responsibilities'], count: responsibilities.length, byRole, byScope },
      });
      return c.json(await currentSet(resolved.contactId, resolved.orgId, c.get('auth') as AuthContext));
    },
  );

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
              siteId: contacts.siteId,
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
            // A contact homed at a site the caller cannot reach is hidden, as in orgContacts.
            if (!detail || !canReachContactSite(auth, detail.siteId)) return [];
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
