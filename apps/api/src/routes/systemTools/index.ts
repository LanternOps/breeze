import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requireScope } from '../../middleware/auth';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../../services/permissions';
import { processesRoutes } from './processes';
import { servicesRoutes } from './services';
import { registryRoutes } from './registry';
import { eventLogsRoutes } from './eventLogs';
import { scheduledTasksRoutes } from './scheduledTasks';
import { fileBrowserRoutes } from './fileBrowser';

export const systemToolsRoutes = new Hono();

// Global RBAC: GET/HEAD → devices.read, non-GET → devices.execute
systemToolsRoutes.use(
  '*',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  requireMfa(),
  async (c, next) => {
    const auth = c.get('auth');

    const method = c.req.method.toUpperCase();
    const required = (method === 'GET' || method === 'HEAD')
      ? PERMISSIONS.DEVICES_READ
      : PERMISSIONS.DEVICES_EXECUTE;

    const userPerms = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined
    });

    if (!userPerms) {
      throw new HTTPException(403, { message: 'No permissions found' });
    }

    if (!hasPermission(userPerms, required.resource, required.action)) {
      throw new HTTPException(403, { message: 'Permission denied' });
    }

    (c as any).set('permissions', userPerms);
    await next();
  }
);

// Mount sub-resource routes
systemToolsRoutes.route('/', processesRoutes);
systemToolsRoutes.route('/', servicesRoutes);
systemToolsRoutes.route('/', registryRoutes);
systemToolsRoutes.route('/', eventLogsRoutes);
systemToolsRoutes.route('/', scheduledTasksRoutes);
systemToolsRoutes.route('/', fileBrowserRoutes);

