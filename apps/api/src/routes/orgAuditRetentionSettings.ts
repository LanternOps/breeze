import type { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { ERROR_CODES, auditRetentionPolicySchema } from '@breeze/shared';
import {
  AuditRetentionFloorError,
  getOrgAuditRetentionPolicy,
  upsertOrgAuditRetentionPolicy,
} from '../services/auditRetentionPolicyService';
import { canAccessOrgAuditRetention } from '../services/orgAuditRetentionAccess';

// Admin read/write for an org's audit-log retention policy
// (audit_retention_policies — issue #4633). Registered onto orgRoutes so it
// inherits orgRoutes' authMiddleware — mounting at the top-level api app
// would silently skip auth. Mounting mirrors orgTicketSettings.ts, but the
// scope list deliberately does not: these routes also admit organization
// scope (own org only — issue #5423), while ticket settings stay
// partner/system.

// The access rule (own org only for organization scope, allowlist for partner,
// unbounded for system) lives in canAccessOrgAuditRetention, shared with the
// get_audit_retention AI tool (full-control W18, #6789).
async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (!(await canAccessOrgAuditRetention(auth, id))) {
    return c.json({ error: 'Organization not found', code: ERROR_CODES.NOT_FOUND }, 404);
  }
  return { id };
}

export function registerOrgAuditRetentionSettingsRoutes(orgRoutes: Hono) {
  const requireAuditRead = requirePermission(PERMISSIONS.AUDIT_READ.resource, PERMISSIONS.AUDIT_READ.action);
  const requireAuditManage = requirePermission(PERMISSIONS.AUDIT_MANAGE.resource, PERMISSIONS.AUDIT_MANAGE.action);

  orgRoutes.get(
    '/organizations/:id/audit-retention',
    requireScope('organization', 'partner', 'system'),
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
    requireScope('organization', 'partner', 'system'),
    requireAuditManage,
    requireMfa(),
    zValidator('json', auditRetentionPolicySchema),
    async (c) => {
      const body = c.req.valid('json');
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const auth = c.get('auth') as AuthContext;
      let data;
      try {
        // An org-scoped caller (the customer-side Org
        // Admin) cannot shorten retention below the floor — see
        // AUDIT_RETENTION_ORG_FLOOR_DAYS's doc comment. A partner- or
        // system-scope caller on this same route is unaffected.
        data = await upsertOrgAuditRetentionPolicy(org.id, body.retentionDays, {
          enforceOrgFloor: auth.scope === 'organization',
        });
      } catch (err) {
        if (err instanceof AuditRetentionFloorError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

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
