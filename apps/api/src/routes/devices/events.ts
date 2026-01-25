import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceCommands } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const eventsRoutes = new Hono();

eventsRoutes.use('*', authMiddleware);

// GET /devices/:id/events - Get events/logs for a device
eventsRoutes.get(
  '/:id/events',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const levels = c.req.query('levels')?.split(',') || ['error', 'warning', 'info'];

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // For now, return recent commands as events since we don't have a separate events table
    const commands = await db
      .select({
        id: deviceCommands.id,
        type: deviceCommands.type,
        status: deviceCommands.status,
        result: deviceCommands.result,
        createdAt: deviceCommands.createdAt,
        completedAt: deviceCommands.completedAt
      })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId))
      .orderBy(desc(deviceCommands.createdAt))
      .limit(100);

    // Transform commands into event format
    const events = commands.map(cmd => ({
      id: cmd.id,
      level: cmd.status === 'failed' ? 'error' : cmd.status === 'completed' ? 'info' : 'warning',
      type: cmd.type,
      message: `Command ${cmd.type}: ${cmd.status}`,
      timestamp: cmd.completedAt || cmd.createdAt,
      details: cmd.result
    })).filter(e => levels.includes(e.level));

    return c.json({ data: events });
  }
);
