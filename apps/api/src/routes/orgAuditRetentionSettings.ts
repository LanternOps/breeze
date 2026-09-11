import type { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { auditRetentionPolicySchema } from '@breeze/shared';
import { getOrgAuditRetentionPolicy, upsertOrgAuditRetentionPolicy } from '../services/auditRetentionPolicyService';

// Admin read/write for an org's audit-log retention policy
// (audit_retention_policies — issue #4633). Registered onto orgRoutes so it
// inherits orgRoutes' authMiddleware — mounting at the top-level api app
// would silently skip auth. Mirrors orgTicketSettings.ts.

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

export function registerOrgAuditRetentionSettingsRoutes(orgRoutes: Hono) {
  const requireAuditRead = requirePermission(PERMISSIONS.AUDIT_READ.resource, PERMISSIONS.AUDIT_READ.action);
  const requireAuditManage = requirePermission(PERMISSIONS.AUDIT_MANAGE.resource, PERMISSIONS.AUDIT_MANAGE.action);

  orgRoutes.get(
    '/organizations/:id/audit-retention',
    requireScope('partner', 'system'),
    requireAuditRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const data = await getOrgAuditRetentionPolicy(org.id);
      return c.json({ data });
    }
  );

  orgRoutes.put(
    '/organizations/:id/audit-retention',
    requireScope('partner', 'system'),
    requireAuditManage,
    requireMfa(),
    zValidator('json', auditRetentionPolicySchema),
    async (c) => {
      const body = c.req.valid('json');
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const data = await upsertOrgAuditRetentionPolicy(org.id, body.retentionDays);

      writeRouteAudit(c, {
        orgId: org.id,
        action: 'organization.audit_retention.update',
        resourceType: 'organization',
        resourceId: org.id,
        details: { retentionDays: body.retentionDays }
      });

      return c.json({ data });
    }
  );
}
