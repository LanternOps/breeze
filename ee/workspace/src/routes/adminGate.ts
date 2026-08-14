import type { MiddlewareHandler } from 'hono';

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
    workspaceOrgId: string;
  };
};

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

  c.set('workspaceOrgId', orgId);
  await next();
};

