import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { checkRemoteAccess } from '../../services/remoteAccessPolicy';
import { processesRoutes } from './processes';
import { servicesRoutes } from './services';
import { registryRoutes } from './registry';
import { eventLogsRoutes } from './eventLogs';
import { scheduledTasksRoutes } from './scheduledTasks';
import { fileBrowserRoutes } from './fileBrowser';
import { getDeviceWithOrgCheck } from './helpers';

export const systemToolsRoutes = new Hono();

// Global RBAC: every method requires devices:execute. Each /system-tools route
// — including the GETs that list processes, services, scheduled tasks, event
// logs, files and registry keys — dispatches a live command to the device's
// agent and returns what it reads, so live device inspection is an
// execute-level operation. devices:read alone covers the cached inventory
// reads under /devices, not these. Keep this a router-level requirePermission:
// aiGuardrails.routeBinding.contract.test.ts reads it to hold the equivalent
// AI tools (manage_processes, manage_scheduled_tasks, manage_services,
// file_operations, registry_operations) to the same permission.
systemToolsRoutes.use(
  '*',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  requireMfa(),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
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
        // A parked device carries its own code (DEVICE_PENDING_ASSIGNMENT).
        if (policyCheck.code) {
          return c.json({ error: policyCheck.reason, message: policyCheck.reason, code: policyCheck.code }, 403);
        }
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
