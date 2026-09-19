import type { MiddlewareHandler } from 'hono';
import type { ExtensionRequestAuthorization } from '@breeze/extension-sdk';

export interface WorkspaceAuthContext {
  user: {
    id: string;
    email?: string;
    name?: string;
    isPlatformAdmin?: boolean;
  };
  scope: 'system' | 'partner' | 'organization';
  orgId?: string | null;
  partnerId?: string | null;
  accessibleOrgIds: string[] | null;
}

export type WorkspaceRouteEnv = {
  Variables: {
    auth: WorkspaceAuthContext;
    extensionAuthorization: ExtensionRequestAuthorization;
    workspaceOrgId: string;
  };
};

const WORKSPACE_RESOURCE = 'workspace';

function requiredPermissions(method: string, path: string): Array<[string, string]> {
  if (method === 'GET' || method === 'HEAD') {
    return path.includes('/devices/')
      ? [[WORKSPACE_RESOURCE, 'read'], ['devices', 'read']]
      : [[WORKSPACE_RESOURCE, 'read']];
  }
  if (path.endsWith('/credential')) {
    return [
      [WORKSPACE_RESOURCE, 'credentials'],
      [WORKSPACE_RESOURCE, 'write'],
      [WORKSPACE_RESOURCE, 'execute'],
      ['devices', 'execute'],
    ];
  }
  if (path.includes('/content/') && !path.endsWith('/content/settings')) {
    return [[WORKSPACE_RESOURCE, 'execute'], ['devices', 'execute']];
  }
  // Creating or changing an active source changes what endpoint agents crawl,
  // so configuration authority alone is insufficient: it also requires the
  // explicit Workspace and core device-execution grants.
  if (path.includes('/sources')) {
    return [
      [WORKSPACE_RESOURCE, 'write'],
      [WORKSPACE_RESOURCE, 'execute'],
      ['devices', 'execute'],
    ];
  }
  return [[WORKSPACE_RESOURCE, 'write']];
}

export const adminGate: MiddlewareHandler<WorkspaceRouteEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth || (auth.scope !== 'partner' && auth.scope !== 'system')) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const orgId = c.req.query('orgId')?.trim();
  if (!orgId) {
    return c.json({ error: 'orgId is required' }, 400);
  }

  // accessibleOrgIds: null is the "unrestricted" sentinel and is honored for
  // system scope only. Partner-scoped principals must always carry an explicit
  // org list — a missing list (e.g. an upstream lookup failure populating
  // null) fails closed instead of granting cross-tenant access.
  if (auth.scope !== 'system' && !Array.isArray(auth.accessibleOrgIds)) {
    return c.json({ error: 'Organization access denied' }, 403);
  }
  if (Array.isArray(auth.accessibleOrgIds) && !auth.accessibleOrgIds.includes(orgId)) {
    return c.json({ error: 'Organization access denied' }, 403);
  }

  const authorization = c.get('extensionAuthorization');
  if (!authorization) {
    return c.json({ error: 'Permission denied' }, 403);
  }
  if (
    requiredPermissions(c.req.method, c.req.path)
      .some(([resource, action]) => !authorization.hasPermission(resource, action))
  ) {
    return c.json({ error: 'Permission denied' }, 403);
  }
  if (!['GET', 'HEAD'].includes(c.req.method) && !authorization.mfaSatisfied) {
    return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }
  // Current interactive partner/system sessions have no site restriction.
  // Workspace's present schema and services cannot express a durable site
  // ceiling for sources, processing, dashboards, or device summaries, so a
  // future restricted principal must fail closed across this entire gate.
  if (authorization.allowedSiteIds !== undefined) {
    return c.json({ error: 'Site-restricted Workspace access is not supported' }, 403);
  }

  c.set('workspaceOrgId', orgId);
  await next();
};
