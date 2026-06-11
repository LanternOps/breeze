import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db';
import { scriptExecutions, scripts } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getDeviceWithOrgCheck } from './helpers';

export const scriptsRoutes = new Hono();

scriptsRoutes.use('*', authMiddleware);

function canAccessDeviceSite(device: { siteId?: string | null }, userPerms: UserPermissions | undefined): boolean {
  if (!userPerms?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(userPerms, device.siteId);
}

// GET /devices/:id/scripts - Get script execution history for a device
scriptsRoutes.get(
  '/:id/scripts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const executions = await db
      .select({
        id: scriptExecutions.id,
        scriptId: scriptExecutions.scriptId,
        scriptName: scripts.name,
        status: scriptExecutions.status,
        exitCode: scriptExecutions.exitCode,
        stdout: scriptExecutions.stdout,
        stderr: scriptExecutions.stderr,
        errorMessage: scriptExecutions.errorMessage,
        startedAt: scriptExecutions.startedAt,
        completedAt: scriptExecutions.completedAt,
        createdAt: scriptExecutions.createdAt
      })
      .from(scriptExecutions)
      .leftJoin(scripts, eq(scriptExecutions.scriptId, scripts.id))
      .where(eq(scriptExecutions.deviceId, deviceId))
      .orderBy(desc(scriptExecutions.createdAt))
      .limit(50);

    return c.json({ data: executions });
  }
);
