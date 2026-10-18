import type { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema';
import { hasSatisfiedMfa, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { createAuditLogAsync } from '../services/auditService';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import {
  readStoredCustomerAdminsNotified,
  resolveCustomerAdminsNotifiedFrom,
} from '../services/connectionHealth/customerDelivery';

/**
 * "Customer org admins receive connection health notices" (spec 2026-10-15 §6,
 * W5 plan D1–D3). The one home of the setting: partner default → org override,
 * null = inherit (org) / off (partner). Every write is a single path-level
 * jsonb update of `settings.connectionHealth.customerAdminsNotified`, so no
 * other key of the settings blob is read or rewritten.
 *
 * Mounted on connectionHealthRoutes (which owns authMiddleware) under /settings.
 * Org-scope callers can neither read nor write it: the setting decides what an
 * MSP sends its customers, so a customer admin must not switch it on for
 * themselves.
 */

const ACTION = 'connection_health.settings.updated';
const KEY = 'customerAdminsNotified';
const bodySchema = z.object({ customerAdminsNotified: z.boolean().nullable() }).strict();
const querySchema = z.object({ orgId: z.string().uuid().optional() });
const paramSchema = z.object({ orgId: z.string().uuid() });

/**
 * Sets (boolean) or removes (null) the key inside `settings.connectionHealth`,
 * creating the block when absent and replacing a malformed (non-object) value.
 */
export function customerAdminsSettingsUpdate(column: SQL | unknown, value: boolean | null): SQL {
  const base = sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END`;
  const block = sql`CASE WHEN jsonb_typeof(${column}->'connectionHealth') = 'object' THEN ${column}->'connectionHealth' ELSE '{}'::jsonb END`;
  const next = value === null
    ? sql`(${block}) - 'customerAdminsNotified'`
    : sql`(${block}) || jsonb_build_object('customerAdminsNotified', ${value}::boolean)`;
  return sql`jsonb_set(${base}, '{connectionHealth}', ${next}, true)`;
}

/** Whether this caller passes the shared write gates (orgs:write + MFA). */
function canWrite(auth: AuthContext, perms: UserPermissions | undefined): boolean {
  return !!perms
    && hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)
    && hasSatisfiedMfa(auth);
}

export function registerConnectionHealthSettingsRoutes(app: Hono): void {
  app.get(
    '/settings',
    requireScope('partner', 'system'),
    requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
    zValidator('query', querySchema),
    async (c) => {
      const auth = c.get('auth');
      const { orgId } = c.req.valid('query');

      let partnerId = auth.partnerId ?? null;
      let orgSettings: unknown = null;
      if (orgId) {
        if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
        // Caller's RLS context: an org they cannot see is simply absent.
        const [org] = await db
          .select({ settings: organizations.settings, partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        if (!org || (auth.scope === 'partner' && org.partnerId !== auth.partnerId)) {
          return c.json({ error: 'Organization not found' }, 404);
        }
        partnerId = org.partnerId;
        orgSettings = org.settings;
      }
      if (!partnerId) return c.json({ error: 'orgId is required without a partner context' }, 400);

      // Partner-axis row, pinned to a partner id derived from the caller or an access-checked org.
      const pinnedPartnerId = partnerId;
      const [partner] = await readWithPartnerAxisVisibility(() =>
        db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, pinnedPartnerId)).limit(1),
      );
      const partnerValue = readStoredCustomerAdminsNotified(partner?.settings, 'partner');
      const writable = canWrite(auth, c.get('permissions'));

      return c.json({
        partner: { customerAdminsNotified: partnerValue, enabled: partnerValue ?? false },
        org: orgId
          ? {
              orgId,
              customerAdminsNotified: readStoredCustomerAdminsNotified(orgSettings, 'organization'),
              ...resolveCustomerAdminsNotifiedFrom(partner?.settings, orgSettings),
            }
          : null,
        canManagePartner: auth.scope === 'partner' && writable && canManagePartnerWidePolicies(auth),
        canManageOrg: !!orgId && writable,
      });
    },
  );

  app.put(
    '/settings/partner',
    requireScope('partner'),
    requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
    requireMfa(),
    zValidator('json', bodySchema),
    async (c) => {
      const auth = c.get('auth');
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
      if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      const value = c.req.valid('json')[KEY];
      const rows = await db
        .update(partners)
        .set({ settings: customerAdminsSettingsUpdate(partners.settings, value), updatedAt: new Date() })
        .where(eq(partners.id, auth.partnerId))
        .returning({ id: partners.id });
      if (rows.length === 0) return c.json({ error: 'Partner not found' }, 404);
      await createAuditLogAsync({
        orgId: null,
        partnerId: auth.partnerId,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: ACTION,
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: { level: 'partner', [KEY]: value },
        result: 'success',
        initiatedBy: 'manual',
      });
      return c.json({ partner: { customerAdminsNotified: value, enabled: value ?? false } });
    },
  );

  app.put(
    '/settings/orgs/:orgId',
    requireScope('partner', 'system'),
    requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
    requireMfa(),
    zValidator('param', paramSchema),
    zValidator('json', bodySchema),
    async (c) => {
      const auth = c.get('auth');
      const { orgId } = c.req.valid('param');
      if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
      const value = c.req.valid('json')[KEY];
      const where = auth.scope === 'partner' && auth.partnerId
        ? and(eq(organizations.id, orgId), eq(organizations.partnerId, auth.partnerId))
        : eq(organizations.id, orgId);
      const rows = await db
        .update(organizations)
        .set({ settings: customerAdminsSettingsUpdate(organizations.settings, value), updatedAt: new Date() })
        .where(where)
        .returning({ id: organizations.id });
      if (rows.length === 0) return c.json({ error: 'Organization not found' }, 404);
      await createAuditLogAsync({
        orgId,
        partnerId: auth.partnerId ?? null,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: ACTION,
        resourceType: 'organization',
        resourceId: orgId,
        details: { level: 'organization', [KEY]: value },
        result: 'success',
        initiatedBy: 'manual',
      });
      return c.json({ org: { orgId, customerAdminsNotified: value } });
    },
  );
}
