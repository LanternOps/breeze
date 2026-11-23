import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import type { AuthContext } from '../../middleware/auth';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
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
} from '../../services/configurationPolicy';
import type { ConfigAssignmentLevel } from '../../services/configurationPolicy';
import { invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import {
  assignPolicySchema,
  targetQuerySchema,
  idParamSchema,
  assignmentIdParamSchema,
} from './schemas';

import type { UserPermissions } from '../../services/permissions';
import { checkAddArming, checkAddLevel, checkPolicyAssignableBy } from './assignmentGates';
import { assignmentApplyRoutes } from './assignmentsApply';
import { resolveAssignmentTargetOwner } from './assignmentTargetOwner';

export const assignmentRoutes = new Hono();
// POST /:id/assignments/apply — the staged Apply (#12466); its own file.
assignmentRoutes.route('/', assignmentApplyRoutes);
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
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', assignPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    // Partner-owned policies need full partner org access for ANY assignment
    // write (#2280); see checkPolicyAssignableBy.
    const assignable = checkPolicyAssignableBy(auth, policy);
    if (!assignable.ok) return c.json(assignable.body, assignable.status);

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
      const status = targetValidation.code === 'PARTNER_GROUP_TARGET_UNSUPPORTED' ? targetValidation.status : 403;
      return c.json({ error: targetValidation.error, code: targetValidation.code }, status);
    }

    // Site sub-axis (SR5-07): RLS does not enforce the site allowlist, so a
    // site-restricted caller must be blocked from assigning to org/partner
    // targets or to a site/group/device outside their allowed sites.
    const siteAuth = await authorizeAssignmentTarget(auth, data.level, targetId);
    if (!siteAuth.valid) {
      return c.json({ error: siteAuth.error }, 403);
    }

    // Helper branding (409), then the arming gates (HP CMSL #5511, vendor
    // updates #11070), in that order; see assignmentGates.ts.
    const levelGate = checkAddLevel(policy, data.level);
    if (!levelGate.ok) return c.json(levelGate.body, levelGate.status);
    const armingGate = checkAddArming(auth, c.get('permissions') as UserPermissions | undefined, policy);
    if (!armingGate.ok) return c.json(armingGate.body, armingGate.status);

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
  requireMfa(),
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
    const assignable = checkPolicyAssignableBy(auth, policy);
    if (!assignable.ok) return c.json(assignable.body, assignable.status);

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

    // MSP-managed (partner-owned, org_id NULL) policies are listed to a
    // partner-scope caller of their own partner when the caller may act on the
    // target (#12466): the target's organization must be one they can access,
    // and a partner-owned group or the partner target itself needs full
    // partner access. Every row shares the target, so its owner is read once,
    // and only when a partner-owned row is present. Org-scope callers still
    // see none of them (W03a applies the read rule there).
    const hasPartnerOwned = auth.scope === 'partner' && result.some((r) => r.policyOrgId === null);
    const targetOwner = hasPartnerOwned
      ? await resolveAssignmentTargetOwner(query.level, query.targetId)
      : null;
    const callerMaySeePartnerOwned = (policyPartnerId: string | null): boolean => {
      if (auth.scope !== 'partner' || !auth.partnerId || policyPartnerId !== auth.partnerId) return false;
      if (!targetOwner) return false;
      if (targetOwner.kind === 'organization') return auth.canAccessOrg(targetOwner.orgId);
      return targetOwner.partnerId === auth.partnerId && canManagePartnerWidePolicies(auth);
    };

    // Filter results to only include policies the caller can access
    const filtered = result.filter((r) => {
      if (auth.scope === 'system') return true;
      if (r.policyOrgId === null) return callerMaySeePartnerOwned(r.policyPartnerId);
      if (auth.scope === 'organization') return auth.orgId === r.policyOrgId;
      return auth.canAccessOrg(r.policyOrgId);
    });

    return c.json({ data: filtered });
  }
);
