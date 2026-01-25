import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db';
import { scriptExecutions, scripts } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const scriptsRoutes = new Hono();

scriptsRoutes.use('*', authMiddleware);

// GET /devices/:id/scripts - Get script execution history for a device
scriptsRoutes.get(
  '/:id/scripts',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
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
