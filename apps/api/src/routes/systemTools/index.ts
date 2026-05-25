import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requireScope } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { checkRemoteAccess } from '../../services/remoteAccessPolicy';
import { processesRoutes } from './processes';
import { servicesRoutes } from './services';
import { registryRoutes } from './registry';
import { eventLogsRoutes } from './eventLogs';
import { scheduledTasksRoutes } from './scheduledTasks';
import { fileBrowserRoutes } from './fileBrowser';
import { getDeviceWithOrgCheck } from './helpers';

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

// Device chokepoint: every system tool executes against a live device, so org
// and site restrictions must be checked before any policy lookup or command.
systemToolsRoutes.use(
  '/devices/:deviceId/*',
  async (c, next) => {
    const deviceId = c.req.param('deviceId');
    if (!deviceId) {
      await next();
      return;
    }

    const auth = c.get('auth');
    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      throw new HTTPException(404, { message: 'Device not found or access denied' });
    }

    const userPerms = c.get('permissions') as UserPermissions | undefined;
    if (userPerms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId))) {
      throw new HTTPException(403, { message: 'Access to this site denied' });
    }

    await next();
  }
);

// Remote access policy enforcement — applies to all system tools routes
systemToolsRoutes.use(
  '/devices/:deviceId/*',
  async (c, next) => {
    const deviceId = c.req.param('deviceId');
    if (deviceId) {
      const policyCheck = await checkRemoteAccess(deviceId, 'remoteTools');
      if (!policyCheck.allowed) {
        throw new HTTPException(403, { message: policyCheck.reason ?? 'Remote tools disabled by policy' });
      }
    }
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
