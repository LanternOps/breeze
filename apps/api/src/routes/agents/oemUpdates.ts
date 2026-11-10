import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import { oemUpdateVerificationSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { applyOemUpdateVerification } from '../../services/oemUpdates/results';

export const oemUpdatesRoutes = new Hono();

oemUpdatesRoutes.use('*', requireAgentRole);

/**
 * The agent's report after the reboot that follows a vendor update (#11065): is
 * BitLocker protecting the volume again, and which BIOS version came up. A report
 * for a run that is not the device's current one answers `applied: false`, so the
 * agent drops it rather than retrying.
 */
oemUpdatesRoutes.put(
  '/:id/oem-updates/verification',
  bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', oemUpdateVerificationSchema),
  async (c) => {
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.agentId, c.req.param('id')))
      .limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const applied = await applyOemUpdateVerification({ deviceId: device.id, verification: c.req.valid('json') });
    return c.json({ applied });
  },
);
