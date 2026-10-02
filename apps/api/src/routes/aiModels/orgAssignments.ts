/**
 * /ai/models/orgs/:orgId — org narrowing of the partner's AI model defaults
 * (W04, #7602). The org's partner comes from the org row, never from input.
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { orgAssignmentsPutSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, hasPermission } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { readOrgPartnerId } from '../../services/aiModels/candidateLoader';
import { buildOrgModelDefaults } from '../../services/aiModels/registryView';
import { putOrgAssignments, touchesSurface } from '../../services/aiModels/assignmentWrites';
import { APPROVALS_DECIDE_REQUIRED, canDecideApprovals, registryWrite } from './shared';

export const aiModelOrgAssignmentRoutes = new Hono();

const orgIdParamSchema = z.object({ orgId: z.string().uuid() });

/** The org's partner, after the caller's org access is proven. Never trusts input for the partner id. */
async function orgPartnerFor(c: Context, orgId: string): Promise<string> {
  const auth = c.get('auth');
  if (!auth?.canAccessOrg?.(orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
  const partnerId = await readOrgPartnerId(orgId);
  if (!partnerId) throw new HTTPException(404, { message: 'Organization not found' });
  if (auth.scope === 'partner' && auth.partnerId !== partnerId) throw new HTTPException(404, { message: 'Organization not found' });
  return partnerId;
}

aiModelOrgAssignmentRoutes.get('/:orgId/assignments',
  requireScope('partner', 'system', 'organization'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const partnerId = await orgPartnerFor(c, orgId);
    const perms = c.get('permissions');
    const canEdit = Boolean(perms) && hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
    return c.json(await buildOrgModelDefaults({ partnerId, orgId, canEdit, canEditReviewer: canEdit && canDecideApprovals(c) }));
  });

aiModelOrgAssignmentRoutes.put('/:orgId/assignments',
  requireScope('partner', 'system', 'organization'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgAssignmentsPutSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const partnerId = await orgPartnerFor(c, orgId);
    const { assignments } = c.req.valid('json');
    // Same rule as the partner PUT: the script reviewer's model is a privileged setting.
    if (touchesSurface(assignments, 'script_reviewer') && !canDecideApprovals(c)) return c.json(APPROVALS_DECIDE_REQUIRED, 403);
    return registryWrite(c, partnerId, async () => {
      const rows = await putOrgAssignments({ partnerId, orgId, rows: assignments });
      writeRouteAudit(c, {
        orgId,
        action: 'ai_models.org_assignments.updated',
        resourceType: 'organization',
        resourceId: orgId,
        details: { surfaces: assignments.map((a) => a.surface) },
      });
      return c.json({ assignments: rows.map((r) => ({ surface: r.surface, role: r.role, updatedAt: r.updatedAt.toISOString() })) });
    });
  });
