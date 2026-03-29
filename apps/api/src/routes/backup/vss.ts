import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { resolveScopedOrgId } from './helpers';

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

export const vssRoutes = new Hono();

vssRoutes.get('/status/:deviceId', zValidator('param', deviceIdParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { deviceId } = c.req.valid('param');

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (device.orgId !== orgId) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const result = await executeCommand(deviceId, CommandTypes.VSS_WRITER_LIST, {}, {
    userId: auth?.user?.id,
    timeoutMs: 30000,
  });

  if (result.status === 'failed') {
    return c.json({ error: result.error || 'Failed to get VSS status' }, 500);
  }

  try {
    const data = result.stdout ? JSON.parse(result.stdout) : null;
    return c.json({ data });
  } catch {
    return c.json({ data: result.stdout });
  }
});
