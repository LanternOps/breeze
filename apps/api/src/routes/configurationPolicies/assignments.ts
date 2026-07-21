import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
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
  authorizeAssignmentTarget,
  getAssignment,
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/configurationPolicy';
import type { ConfigAssignmentLevel } from '../../services/configurationPolicy';
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
    const authorizedAssignments = await Promise.all(
      assignments.map(async (assignment) => ({
        assignment,
        authorization: await authorizeAssignmentTarget(
          auth,
          assignment.level as ConfigAssignmentLevel,
          assignment.targetId,
        ),
      })),
    );
    return c.json({
      data: authorizedAssignments
        .filter(({ authorization }) => authorization.valid)
        .map(({ assignment }) => assignment),
    });
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

    // Partner-owned policies (org_id NULL) are the partner library (#2280).
    // ANY assignment on one — at any level — pushes config into orgs the caller
    // may not fully control, so all writes require full partner org access, the
    // same capability that gates partner-wide create/update/delete. This
    // supersedes the per-level check that used to live only in the partner block.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    // Partner-level assignments are only valid for partner-OWNED policies, and
    // the target is the partner itself, derived server-side (#1724) — never
    // trust a client-supplied partner id. It's the policy's own partner_id (or
    // the caller's, for a fresh partner-owned policy). Org-owned policies are
    // rejected at the partner level by validateAssignmentTarget below, so the
    // `auth.partnerId` fallback here only ever serves partner-owned policies.
    // The client may omit targetId for the partner level.
    let targetId = data.targetId;
    if (data.level === 'partner') {
      if (policy.partnerId) {
        targetId = policy.partnerId;
      } else if (auth.partnerId) {
        targetId = auth.partnerId;
      } else {
        return c.json({ error: 'Partner-wide assignments require partner scope' }, 403);
      }
    }
    if (!targetId) {
      return c.json({ error: 'targetId is required for this assignment level' }, 400);
    }

    const targetValidation = await validateAssignmentTarget(
      { orgId: policy.orgId, partnerId: policy.partnerId },
      data.level,
      targetId
    );
    if (!targetValidation.valid) {
      return c.json({ error: targetValidation.error }, 403);
    }

    // Site sub-axis (SR5-07): RLS does not enforce the site allowlist, so a
    // site-restricted caller must be blocked from assigning to org/partner
    // targets or to a site/group/device outside their allowed sites.
    const siteAuth = await authorizeAssignmentTarget(auth, data.level, targetId);
    if (!siteAuth.valid) {
      return c.json({ error: siteAuth.error }, 403);
    }

    // assignPolicy returns null (instead of throwing) on a duplicate — see the
    // comment on its onConflictDoNothing insert in configurationPolicy.ts for
    // why the raised-violation catch pattern doesn't work inside this route's
    // withDbAccessContext transaction.
    const assignment = await assignPolicy(
      id,
      data.level,
      targetId,
      data.priority ?? 0,
      auth.user.id,
      data.roleFilter,
      data.osFilter
    );

    if (!assignment) {
      return c.json({ error: 'This policy is already assigned to this target at this level' }, 409);
    }

    // Invalidate remote access policy cache — assignment may affect access decisions
    invalidateRemoteAccessCache();

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.assign',
      resourceType: 'configuration_policy',
      resourceId: id,
      resourceName: policy.name,
      details: { level: data.level, targetId, priority: data.priority },
    });

    return c.json(assignment, 201);
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

    // Any assignment on a partner-owned library policy (#2280) — partner-level
    // (all orgs) or a narrower org/site/group/device row — is a partner-wide-
    // access capability: the delete may strip config from one org or every org
    // under the partner. Same blast radius as assigning, so the same gate applies.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    // Site sub-axis (SR5-07): re-check against the stored target so a
    // site-restricted caller can't remove an assignment that reaches a site,
    // group, or device outside their allowlist (RLS does not enforce site).
    const existing = await getAssignment(aid, id);
    if (!existing) return c.json({ error: 'Assignment not found' }, 404);
    const siteAuth = await authorizeAssignmentTarget(
      auth,
      existing.level as ConfigAssignmentLevel,
      existing.targetId
    );
    if (!siteAuth.valid) {
      return c.json({ error: siteAuth.error }, 403);
    }

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
    const siteAuth = await authorizeAssignmentTarget(auth, query.level, query.targetId);
    if (!siteAuth.valid) {
      return c.json({ error: siteAuth.error }, 403);
    }
    const result = await listAssignmentsForTarget(query.level, query.targetId);

    // Filter results to only include policies the caller can access
    const filtered = result.filter((r) => {
      if (auth.scope === 'system') return true;
      // Partner-owned policies (org_id NULL, #1724) aren't org-scoped, so an
      // org-axis access check can't apply — exclude them from these scopes.
      if (r.policyOrgId === null) return false;
      if (auth.scope === 'organization') return auth.orgId === r.policyOrgId;
      return auth.canAccessOrg(r.policyOrgId);
    });

    return c.json({ data: filtered });
  }
);
