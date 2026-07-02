import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { organizations } from '../../db/schema';
import {
  createConfigPolicy,
  getConfigPolicy,
  listConfigPolicies,
  updateConfigPolicy,
  deleteConfigPolicy,
  assignPolicy,
  canManagePartnerWidePolicies,
  PartnerWideWriteDeniedError,
} from '../../services/configurationPolicy';
import { invalidateRemoteAccessCache } from '../../services/remoteAccessPolicy';
import {
  createConfigPolicySchema,
  updateConfigPolicySchema,
  listConfigPoliciesSchema,
  idParamSchema,
} from './schemas';

export const crudRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

// GET / — list configuration policies
crudRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('query', listConfigPoliciesSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(Math.max(1, Number(query.limit) || 25), 100);

    const result = await listConfigPolicies(auth, {
      status: query.status,
      search: query.search,
      orgId: query.orgId,
    }, { page, limit });

    return c.json(result);
  }
);

// POST / — create configuration policy
crudRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('json', createConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');

    // Partner-wide / all-orgs policy (#1724). The partner is ALWAYS derived from
    // the caller's own token — never from a client-supplied value — so a caller
    // cannot create a policy owned by another partner. Org-scope callers have no
    // partner of their own and cannot own partner-wide policies.
    if (data.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide policies require partner scope' }, 403);
      }
      // Guard: partner-wide policies affect devices in ALL orgs under the partner.
      // A user with orgAccess='selected' or 'none' only has visibility into a
      // subset of orgs — granting them partner-wide policy create would silently
      // push config (remote_access, PAM, monitoring, patch) to orgs they cannot
      // access. Only orgAccess='all' partner users (and system scope) may create
      // partner-wide policies. The same gate protects update/delete (enforced in
      // the service) and feature-link/assignment writes (route gates).
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Partner-wide policies require full partner org access (orgAccess must be "all")' }, 403);
      }
      const policy = await createConfigPolicy({ partnerId: auth.partnerId }, data, auth.user.id);
      // Seed the matching partner-level assignment so the policy actually
      // applies the moment it's created. Ownership ("Scope: All organizations")
      // and the assignment that drives resolution are kept in lockstep —
      // otherwise a partner-wide policy resolves to NO devices until the user
      // separately discovers the Assignments tab (#1724 follow-up).
      //
      // Both writes run inside the request-level transaction: authMiddleware
      // wraps the handler in withDbAccessContext, which is a single
      // baseDb.transaction. If this seed throws, the policy insert above rolls
      // back with it — a committed-but-unassigned partner-wide policy (the exact
      // "resolves to no devices" state this feature prevents) can't be left
      // behind, and no compensating delete is needed.
      await assignPolicy(policy.id, 'partner', auth.partnerId, 0, auth.user.id);
      writeRouteAudit(c, {
        orgId: null,
        action: 'config_policy.create',
        resourceType: 'configuration_policy',
        resourceId: policy.id,
        resourceName: policy.name,
        details: { ownerScope: 'partner', partnerId: auth.partnerId, autoAssignedPartnerWide: true },
      });
      return c.json(policy, 201);
    }

    let orgId = data.orgId;
    if (auth.scope === 'organization') {
      // Org scope always owns the policy in its own org — a client-supplied
      // orgId is ignored so an org user can't create a policy in another org.
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        const accessibleOrgs = auth.accessibleOrgIds ?? [];
        const [onlyOrg] = accessibleOrgs;
        if (accessibleOrgs.length === 1 && onlyOrg) {
          orgId = onlyOrg;
        } else {
          // Distinguish "nothing to own it" from "ambiguous which org" so the
          // caller gets an actionable message rather than a misleading one.
          return c.json(
            {
              error:
                accessibleOrgs.length === 0
                  ? 'No accessible organization to own this policy'
                  : 'orgId is required when the partner has multiple organizations',
            },
            400
          );
        }
      }
      if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
    } else if (auth.scope === 'system') {
      if (!orgId) return c.json({ error: 'orgId is required' }, 400);
      // System scope bypasses the org-access checks above, so a non-existent
      // orgId would otherwise fail as a raw FK 500 at insert time. Surface a
      // clean 404 instead. (System context sees all orgs — no RLS filter.)
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!org) return c.json({ error: 'Organization not found' }, 404);
    }

    // Org-owned policies are intentionally NOT auto-assigned (unlike partner-wide
    // above): an org policy is commonly meant for a specific site/group/device,
    // so auto-assigning it at the org level would silently over-apply to every
    // device in the org. The user picks the assignment target explicitly.
    const policy = await createConfigPolicy({ orgId: orgId as string }, data, auth.user.id);

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.create',
      resourceType: 'configuration_policy',
      resourceId: policy.id,
      resourceName: policy.name,
    });

    return c.json(policy, 201);
  }
);

// GET /:id — get configuration policy with feature links
crudRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    return c.json(policy);
  }
);

// PATCH /:id — update configuration policy metadata
crudRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', idParamSchema),
  zValidator('json', updateConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    let updated;
    try {
      updated = await updateConfigPolicy(id, data, auth);
    } catch (err) {
      if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!updated) return c.json({ error: 'Configuration policy not found' }, 404);

    invalidateRemoteAccessCache();

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'config_policy.update',
      resourceType: 'configuration_policy',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(data) },
    });

    return c.json(updated);
  }
);

// DELETE /:id — delete configuration policy (cascades)
crudRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    let deleted;
    try {
      deleted = await deleteConfigPolicy(id, auth);
    } catch (err) {
      if (err instanceof PartnerWideWriteDeniedError) return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!deleted) return c.json({ error: 'Configuration policy not found' }, 404);

    invalidateRemoteAccessCache();

    writeRouteAudit(c, {
      orgId: deleted.orgId,
      action: 'config_policy.delete',
      resourceType: 'configuration_policy',
      resourceId: deleted.id,
      resourceName: deleted.name,
    });

    return c.json({ success: true });
  }
);
