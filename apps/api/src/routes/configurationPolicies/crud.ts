import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  createConfigPolicy,
  getConfigPolicy,
  listConfigPolicies,
  updateConfigPolicy,
  deleteConfigPolicy,
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
      // partner-wide policies. requireConfigPolicyWrite (requirePermission)
      // already populated c.get('permissions') with the caller's orgAccess.
      const userPerms = c.get('permissions') as UserPermissions | undefined;
      if (auth.scope !== 'system' && userPerms?.orgAccess !== 'all') {
        return c.json({ error: 'Partner-wide policies require full partner org access (orgAccess must be "all")' }, 403);
      }
      const policy = await createConfigPolicy({ partnerId: auth.partnerId }, data, auth.user.id);
      writeRouteAudit(c, {
        orgId: null,
        action: 'config_policy.create',
        resourceType: 'configuration_policy',
        resourceId: policy.id,
        resourceName: policy.name,
        details: { ownerScope: 'partner', partnerId: auth.partnerId },
      });
      return c.json(policy, 201);
    }

    let orgId = data.orgId;
    if (auth.scope === 'organization') {
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
      }
      if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

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

    const updated = await updateConfigPolicy(id, data, auth);
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

    const deleted = await deleteConfigPolicy(id, auth);
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
