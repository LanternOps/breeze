import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  createConfigPolicy,
  getConfigPolicy,
  listConfigPolicies,
  updateConfigPolicy,
  deleteConfigPolicy,
} from '../../services/configurationPolicy';
import {
  createConfigPolicySchema,
  updateConfigPolicySchema,
  listConfigPoliciesSchema,
  idParamSchema,
} from './schemas';

export const crudRoutes = new Hono();

// GET / — list configuration policies
crudRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
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
  zValidator('json', createConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');

    let orgId = data.orgId;
    if (auth.scope === 'organization') {
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) return c.json({ error: 'orgId is required for partner scope' }, 400);
      if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const policy = await createConfigPolicy(orgId as string, data, auth.user.id);

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
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const deleted = await deleteConfigPolicy(id, auth);
    if (!deleted) return c.json({ error: 'Configuration policy not found' }, 404);

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
