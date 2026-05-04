import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import {
  getConfigPolicy,
  assignPolicy,
  unassignPolicy,
  listAssignments,
  listAssignmentsForTarget,
  validateAssignmentTarget,
} from '../../services/configurationPolicy';
import { invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import {
  assignPolicySchema,
  targetQuerySchema,
  idParamSchema,
  assignmentIdParamSchema,
} from './schemas';

export const assignmentRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

// GET /:id/assignments — list assignments for a policy
assignmentRoutes.get(
  '/:id/assignments',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const assignments = await listAssignments(id);
    return c.json({ data: assignments });
  }
);

// POST /:id/assignments — assign policy to a target
assignmentRoutes.post(
  '/:id/assignments',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', idParamSchema),
  zValidator('json', assignPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const targetValidation = await validateAssignmentTarget(policy.orgId, data.level, data.targetId);
    if (!targetValidation.valid) {
      return c.json({ error: targetValidation.error ?? 'Assignment target is not valid for this policy organization' }, 403);
    }

    try {
      const assignment = await assignPolicy(
        id,
        data.level,
        data.targetId,
        data.priority ?? 0,
        auth.user.id,
        data.roleFilter,
        data.osFilter
      );

      // Invalidate remote access policy cache — assignment may affect access decisions
      invalidateRemoteAccessCache();

      writeRouteAudit(c, {
        orgId: policy.orgId,
        action: 'config_policy.assign',
        resourceType: 'configuration_policy',
        resourceId: id,
        resourceName: policy.name,
        details: { level: data.level, targetId: data.targetId, priority: data.priority },
      });

      return c.json(assignment, 201);
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ error: 'This policy is already assigned to this target at this level' }, 409);
      }
      throw err;
    }
  }
);

// DELETE /:id/assignments/:aid — unassign
assignmentRoutes.delete(
  '/:id/assignments/:aid',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', assignmentIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id, aid } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const deleted = await unassignPolicy(aid, id);
    if (!deleted) return c.json({ error: 'Assignment not found' }, 404);

    // Invalidate remote access policy cache — unassignment may affect access decisions
    invalidateRemoteAccessCache();

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.unassign',
      resourceType: 'configuration_policy',
      resourceId: id,
      resourceName: policy.name,
      details: { assignmentId: aid, level: deleted.level, targetId: deleted.targetId },
    });

    return c.json({ success: true });
  }
);

// GET /assignments/target — list assignments for a specific target
assignmentRoutes.get(
  '/assignments/target',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('query', targetQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const result = await listAssignmentsForTarget(query.level, query.targetId);

    // Filter results to only include policies the caller can access
    const filtered = result.filter((r) => {
      if (auth.scope === 'system') return true;
      if (auth.scope === 'organization') return auth.orgId === r.policyOrgId;
      return auth.canAccessOrg(r.policyOrgId);
    });

    return c.json({ data: filtered });
  }
);
